/**
 * 有限时序条件监测库：编译形如 “A 后 d tick 内出现 B 且期间无 C” 的条件，
 * 逐 tick 驱动实例机，输出匹配/违例证据，支持快照续行。
 *
 * 语义约定：
 * - 每个 A（trigger）输入生成一个独立实例，ID 单调递增。
 * - 实例期限 deadline = 触发 tick + window；B 在 deadline 当 tick 到达仍算匹配。
 * - 同一 tick 内：先处理全部输入（input），endTick() 时才做超时判定，
 *   因此 deadline 当 tick 的 B 优先于超时（同 tick 输入先于超时）。
 * - 单个输入事件的处理顺序：先 forbidden 判定，再 expect 匹配，最后 trigger 生成新实例。
 * - cancel(id) 仅注销对应 ID 的实例，其余实例不受影响。
 */

export interface ConditionSpec {
  /** 条件名称，便于报告 */
  name?: string;
  /** 触发事件类型 A */
  trigger: string;
  /** 期望事件类型 B */
  expect: string;
  /** 禁止事件类型 C 列表（窗口内出现即违例） */
  forbid?: string[];
  /** 有限窗口 d（单位：tick，非负整数） */
  window: number;
}

export interface MonitorEvent {
  tick: number;
  type: string;
  payload?: unknown;
}

export type InstanceStatus = 'active' | 'matched' | 'violated' | 'cancelled';

export interface InstanceView {
  id: number;
  triggerTick: number;
  deadline: number;
  status: InstanceStatus;
}

export interface MatchEvidence {
  kind: 'match';
  instanceId: number;
  triggerTick: number;
  matchedTick: number;
  /** matchedTick - triggerTick */
  latency: number;
}

export interface TimeoutEvidence {
  kind: 'violation';
  reason: 'timeout';
  instanceId: number;
  triggerTick: number;
  deadline: number;
  /** 判定超时的 tick（即 deadline 所在 tick 的 endTick） */
  detectedTick: number;
}

export interface ForbiddenEvidence {
  kind: 'violation';
  reason: 'forbidden';
  instanceId: number;
  triggerTick: number;
  /** 触发违例的禁止事件（含 payload，作为证据） */
  forbiddenEvent: MonitorEvent;
}

export type Evidence = MatchEvidence | TimeoutEvidence | ForbiddenEvidence;

/** 每个 tick 的实例枚举记录，用于逐 tick 对照 */
export interface TickRecord {
  tick: number;
  inputs: MonitorEvent[];
  /** 本 tick 产生的证据（匹配/违例） */
  evidence: Evidence[];
  /** 本 tick 被 cancel 的实例 ID */
  cancelled: number[];
  /** 本 tick 结束（超时判定后）仍活跃的实例枚举 */
  activeAfter: Array<{ id: number; triggerTick: number; deadline: number; remaining: number }>;
}

export type MatchPolicy = 'oldest' | 'all';

export interface MonitorOptions {
  /** B 到达时的匹配策略：oldest=只满足最老活跃实例（默认），all=满足全部活跃实例 */
  matchPolicy?: MatchPolicy;
}

export interface Snapshot {
  version: 1;
  spec: Required<Omit<ConditionSpec, 'name'>> & { name?: string };
  matchPolicy: MatchPolicy;
  currentTick: number;
  nextId: number;
  active: Array<{ id: number; triggerTick: number; deadline: number }>;
  outcomes: Evidence[];
  trace: TickRecord[];
  /** 当前 tick 尚未 endTick 的进行中记录 */
  pending: TickRecord;
}

interface MutableInstance {
  id: number;
  triggerTick: number;
  deadline: number;
}

function validateSpec(spec: ConditionSpec): void {
  if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
  if (!spec.trigger) throw new Error('spec.trigger is required');
  if (!spec.expect) throw new Error('spec.expect is required');
  if (!Number.isInteger(spec.window) || spec.window < 0) {
    throw new Error('spec.window must be a non-negative integer');
  }
  if (spec.forbid !== undefined && !Array.isArray(spec.forbid)) {
    throw new Error('spec.forbid must be an array of event types');
  }
}

function emptyRecord(tick: number): TickRecord {
  return { tick, inputs: [], evidence: [], cancelled: [], activeAfter: [] };
}

export class Monitor {
  readonly spec: ConditionSpec;
  private readonly matchPolicy: MatchPolicy;
  private readonly forbidSet: Set<string>;
  private currentTick = 0;
  private nextId = 1;
  private active: MutableInstance[] = [];
  private outcomes: Evidence[] = [];
  private trace: TickRecord[] = [];
  private pending: TickRecord = emptyRecord(0);

  constructor(spec: ConditionSpec, options: MonitorOptions = {}) {
    validateSpec(spec);
    this.spec = { ...spec, forbid: spec.forbid ? [...spec.forbid] : [] };
    this.matchPolicy = options.matchPolicy ?? 'oldest';
    this.forbidSet = new Set(this.spec.forbid);
  }

  /** 当前 tick（尚未 endTick 的 tick） */
  get tick(): number {
    return this.currentTick;
  }

  /** 在当前 tick 输入一个事件。同 tick 可多次调用，全部先于超时判定。 */
  input(type: string, payload?: unknown): void {
    // 未提供 payload 时不设置该键，保证 JSON 快照往返后结构一致
    const event: MonitorEvent =
      payload === undefined
        ? { tick: this.currentTick, type }
        : { tick: this.currentTick, type, payload };
    this.pending.inputs.push(event);

    // 1) 禁止事件：所有活跃实例立即违例，证据含该事件
    if (this.forbidSet.has(type)) {
      for (const inst of this.active) {
        this.emit({
          kind: 'violation',
          reason: 'forbidden',
          instanceId: inst.id,
          triggerTick: inst.triggerTick,
          forbiddenEvent: event,
        });
      }
      this.active = [];
    }

    // 2) 期望事件：按策略匹配活跃实例
    if (type === this.spec.expect && this.active.length > 0) {
      const first = this.active[0];
      const matched: MutableInstance[] =
        this.matchPolicy === 'all' ? [...this.active] : first ? [first] : [];
      for (const inst of matched) {
        this.emit({
          kind: 'match',
          instanceId: inst.id,
          triggerTick: inst.triggerTick,
          matchedTick: this.currentTick,
          latency: this.currentTick - inst.triggerTick,
        });
        this.active.splice(this.active.indexOf(inst), 1);
      }
    }

    // 3) 触发事件：生成新实例（多个 A 各有实例）
    if (type === this.spec.trigger) {
      this.active.push({
        id: this.nextId++,
        triggerTick: this.currentTick,
        deadline: this.currentTick + (this.spec.window as number),
      });
    }
  }

  /**
   * 结束当前 tick：先做超时判定（deadline <= 当前 tick 的活跃实例违例），
   * 固化本 tick 的枚举记录，然后前进 steps 个 tick（默认 1）。
   */
  endTick(steps = 1): void {
    if (!Number.isInteger(steps) || steps < 1) {
      throw new Error('steps must be a positive integer');
    }
    for (let i = 0; i < steps; i++) {
      const survivors: MutableInstance[] = [];
      for (const inst of this.active) {
        if (inst.deadline <= this.currentTick) {
          this.emit({
            kind: 'violation',
            reason: 'timeout',
            instanceId: inst.id,
            triggerTick: inst.triggerTick,
            deadline: inst.deadline,
            detectedTick: this.currentTick,
          });
        } else {
          survivors.push(inst);
        }
      }
      this.active = survivors;
      this.pending.activeAfter = survivors.map((inst) => ({
        id: inst.id,
        triggerTick: inst.triggerTick,
        deadline: inst.deadline,
        remaining: inst.deadline - this.currentTick,
      }));
      this.trace.push(this.pending);
      this.currentTick += 1;
      this.pending = emptyRecord(this.currentTick);
    }
  }

  /** 注销指定 ID 的活跃实例；仅影响该 ID。返回是否注销成功。 */
  cancel(id: number): boolean {
    const idx = this.active.findIndex((inst) => inst.id === id);
    if (idx === -1) return false;
    this.active.splice(idx, 1);
    this.pending.cancelled.push(id);
    return true;
  }

  /** 当前活跃实例枚举（对照用） */
  getActive(): InstanceView[] {
    return this.active.map((inst) => ({
      id: inst.id,
      triggerTick: inst.triggerTick,
      deadline: inst.deadline,
      status: 'active',
    }));
  }

  /** 全部已产生证据（匹配 + 违例），按产生顺序 */
  getOutcomes(): Evidence[] {
    return this.outcomes.map((e) => ({ ...e }));
  }

  /** 逐 tick 枚举记录（已固化的 tick） */
  getTrace(): TickRecord[] {
    return this.trace.map((r) => ({
      ...r,
      inputs: [...r.inputs],
      evidence: [...r.evidence],
      cancelled: [...r.cancelled],
      activeAfter: r.activeAfter.map((a) => ({ ...a })),
    }));
  }

  /** 快照：可 JSON 序列化，供续行 */
  snapshot(): Snapshot {
    return {
      version: 1,
      spec: {
        name: this.spec.name,
        trigger: this.spec.trigger as string,
        expect: this.spec.expect as string,
        forbid: [...(this.spec.forbid ?? [])],
        window: this.spec.window as number,
      },
      matchPolicy: this.matchPolicy,
      currentTick: this.currentTick,
      nextId: this.nextId,
      active: this.active.map((inst) => ({ ...inst })),
      outcomes: this.outcomes.map((e) => ({ ...e })),
      trace: this.getTrace(),
      pending: {
        ...this.pending,
        inputs: [...this.pending.inputs],
        evidence: [...this.pending.evidence],
        cancelled: [...this.pending.cancelled],
        activeAfter: this.pending.activeAfter.map((a) => ({ ...a })),
      },
    };
  }

  /** 快照序列化为 JSON 字符串 */
  snapshotJSON(): string {
    return JSON.stringify(this.snapshot());
  }

  /** 从快照恢复（校验版本与条件一致性），继续运行 */
  static restore(snap: Snapshot, options: MonitorOptions = {}): Monitor {
    if (!snap || snap.version !== 1) throw new Error('unsupported snapshot version');
    const monitor = new Monitor(snap.spec, {
      matchPolicy: options.matchPolicy ?? snap.matchPolicy,
    });
    monitor.currentTick = snap.currentTick;
    monitor.nextId = snap.nextId;
    monitor.active = snap.active.map((inst) => ({ ...inst }));
    monitor.outcomes = snap.outcomes.map((e) => ({ ...e }));
    monitor.trace = snap.trace.map((r) => ({
      ...r,
      inputs: [...r.inputs],
      evidence: [...r.evidence],
      cancelled: [...r.cancelled],
      activeAfter: r.activeAfter.map((a) => ({ ...a })),
    }));
    monitor.pending = {
      ...snap.pending,
      inputs: [...snap.pending.inputs],
      evidence: [...snap.pending.evidence],
      cancelled: [...snap.pending.cancelled],
      activeAfter: snap.pending.activeAfter.map((a) => ({ ...a })),
    };
    return monitor;
  }

  /** 从 JSON 字符串快照恢复 */
  static restoreJSON(json: string, options: MonitorOptions = {}): Monitor {
    return Monitor.restore(JSON.parse(json) as Snapshot, options);
  }

  private emit(evidence: Evidence): void {
    this.outcomes.push(evidence);
    this.pending.evidence.push(evidence);
  }
}

/** 编译时序条件为监测器（轻量工厂，便于表达“编译”步骤） */
export function compile(spec: ConditionSpec, options: MonitorOptions = {}): Monitor {
  return new Monitor(spec, options);
}
