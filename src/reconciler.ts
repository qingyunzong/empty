export type EventType = "create" | "delete";

export interface ObjectEvent {
  type: EventType;
  key: string;
  /** 版本化桶必填；无版本桶忽略。 */
  versionId?: string;
  /** 事件在源侧的发生时间（毫秒）。提供时用于乱序裁决。 */
  eventTime?: number;
}

export interface ListedObject {
  key: string;
  versionId?: string;
}

export type DiscrepancyKind = "missing" | "ghost";

export interface Discrepancy {
  kind: DiscrepancyKind;
  key: string;
  versionId?: string;
}

export interface RoundReport {
  /** 从 1 开始的清单轮次。 */
  round: number;
  /** 连续两轮均存在：事件期望存在但清单缺失。 */
  missing: Discrepancy[];
  /** 连续两轮均存在：清单存在但事件期望不存在（或从未见过）。 */
  ghost: Discrepancy[];
  /** 本轮新出现、尚未被第二轮确认的差异。 */
  pending: Discrepancy[];
  /** 本轮差异集合与上一轮完全一致时为 true（首轮恒为 false）。 */
  converged: boolean;
}

export interface ReconcilerOptions {
  /** true 表示版本化桶，按 (key, versionId) 裁决；默认 false。 */
  versioned?: boolean;
}

interface KeyState {
  present: boolean;
  /** 观测世代：每次“删除后又观测到存在”递增。 */
  generation: number;
  /** 最近一次删除所作用的世代；-1 表示当前世代未被删除。 */
  deletedGeneration: number;
  /** 已应用事件的最大 eventTime；null 表示尚无带时间戳的事件。 */
  lastEventTime: number | null;
}

const ID_SEP = "\u0000";
const FP_SEP = "\u0001";

function freshState(): KeyState {
  return { present: false, generation: 0, deletedGeneration: -1, lastEventTime: null };
}

function sorted(discrepancies: Discrepancy[]): Discrepancy[] {
  return discrepancies.sort((a, b) => {
    const byKey = a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    if (byKey !== 0) return byKey;
    const av = a.versionId ?? "";
    const bv = b.versionId ?? "";
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
}

/**
 * 对象存储通知对账器。
 *
 * - 事件按指纹去重，重复投递安全。
 * - 版本化桶：create/delete 只作用于完全相同的 (key, versionId)。
 * - 无版本桶：带 eventTime 的迟到事件（小于已应用的最大时间）被丢弃；
 *   删除后再次观测到存在（create 事件或清单观测）会推进观测世代，
 *   针对旧世代的迟到删除因此不会误伤重建对象。
 */
export class Reconciler {
  private readonly versioned: boolean;
  private readonly states = new Map<string, KeyState>();
  private readonly seenEvents = new Set<string>();
  private round = 0;
  private prevDiscrepancies: Set<string> | null = null;

  constructor(options: ReconcilerOptions = {}) {
    this.versioned = options.versioned ?? false;
  }

  /** 返回 true 表示事件被应用；重复或迟到事件返回 false。 */
  ingestEvent(event: ObjectEvent): boolean {
    const fingerprint = [
      event.type,
      event.key,
      event.versionId ?? "",
      event.eventTime ?? "",
    ].join(FP_SEP);
    if (this.seenEvents.has(fingerprint)) return false;
    this.seenEvents.add(fingerprint);

    const id = this.versioned
      ? `${event.key}${ID_SEP}${event.versionId ?? ""}`
      : event.key;
    const state = this.states.get(id) ?? freshState();

    if (
      event.eventTime !== undefined &&
      state.lastEventTime !== null &&
      event.eventTime < state.lastEventTime
    ) {
      // 迟到事件：已被更新的观测覆盖，丢弃。
      return false;
    }

    let applied = true;
    if (event.type === "create") {
      if (!state.present && state.deletedGeneration === state.generation) {
        // 删除之后的重建：推进观测世代。
        state.generation += 1;
        state.deletedGeneration = -1;
      }
      state.present = true;
    } else {
      if (state.present) {
        state.present = false;
        state.deletedGeneration = state.generation;
      } else {
        // 已不存在时收到的 delete 是旧世代的迟到/重复删除：不改变状态，
        // 但仍记录其时间戳，使更早到达的乱序 create 被正确判为迟到。
        applied = false;
      }
    }

    if (event.eventTime !== undefined) {
      state.lastEventTime =
        state.lastEventTime === null
          ? event.eventTime
          : Math.max(state.lastEventTime, event.eventTime);
    }
    this.states.set(id, state);
    return applied;
  }

  ingestEvents(events: Iterable<ObjectEvent>): void {
    for (const event of events) this.ingestEvent(event);
  }

  /**
   * 汇入一轮周期清单并产出对账报告。
   * @param observedAt 清单快照时间；提供时早于已应用事件的清单观测不会触发生世推进。
   */
  ingestList(objects: Iterable<ListedObject>, observedAt?: number): RoundReport {
    const listed = new Map<string, ListedObject>();
    for (const object of objects) {
      const id = this.versioned
        ? `${object.key}${ID_SEP}${object.versionId ?? ""}`
        : object.key;
      listed.set(id, object);
    }

    if (!this.versioned) {
      // 清单观测到“事件流认为已删除”的 key：视为重建的新世代观测。
      for (const id of listed.keys()) {
        const state = this.states.get(id);
        if (state === undefined || state.present) continue;
        const staleObservation =
          observedAt !== undefined &&
          state.lastEventTime !== null &&
          observedAt < state.lastEventTime;
        if (!staleObservation) {
          state.generation += 1;
          state.present = true;
          state.deletedGeneration = -1;
        }
      }
    }

    const current = new Map<string, Discrepancy>();
    const add = (kind: DiscrepancyKind, key: string, versionId?: string) => {
      const fingerprint = [kind, key, versionId ?? ""].join(FP_SEP);
      current.set(fingerprint, { kind, key, versionId });
    };

    for (const [id, state] of this.states) {
      if (!state.present || listed.has(id)) continue;
      const [key, versionId] = this.versioned ? id.split(ID_SEP) : [id, undefined];
      add("missing", key, versionId === "" ? undefined : versionId);
    }
    for (const [id, object] of listed) {
      const state = this.states.get(id);
      if (state !== undefined && state.present) continue;
      add("ghost", object.key, object.versionId);
    }

    const missing: Discrepancy[] = [];
    const ghost: Discrepancy[] = [];
    const pending: Discrepancy[] = [];
    for (const [fingerprint, discrepancy] of current) {
      if (this.prevDiscrepancies?.has(fingerprint)) {
        (discrepancy.kind === "missing" ? missing : ghost).push(discrepancy);
      } else {
        pending.push(discrepancy);
      }
    }

    const currentFingerprints = new Set(current.keys());
    const converged =
      this.prevDiscrepancies !== null &&
      currentFingerprints.size === this.prevDiscrepancies.size &&
      [...currentFingerprints].every((fp) => this.prevDiscrepancies!.has(fp));

    this.prevDiscrepancies = currentFingerprints;
    this.round += 1;

    return {
      round: this.round,
      missing: sorted(missing),
      ghost: sorted(ghost),
      pending: sorted(pending),
      converged,
    };
  }

  reset(): void {
    this.states.clear();
    this.seenEvents.clear();
    this.round = 0;
    this.prevDiscrepancies = null;
  }
}
