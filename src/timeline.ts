export type TimelineId = string;
export type Lsn = number;

export interface ArchiveSegment {
  start: Lsn;
  end: Lsn;
}

export type TimelineErrorCode =
  | 'UNKNOWN_TIMELINE'
  | 'DUPLICATE_TIMELINE'
  | 'TIMELINE_SEALED'
  | 'PARENT_NOT_SEALED'
  | 'INVALID_BRANCH_POINT'
  | 'INVALID_SEGMENT'
  | 'INVALID_SNAPSHOT'
  | 'CYCLE_DETECTED';

export class TimelineError extends Error {
  readonly code: TimelineErrorCode;

  constructor(code: TimelineErrorCode, message: string) {
    super(message);
    this.name = 'TimelineError';
    this.code = code;
  }
}

export interface RecoveryHop {
  timelineId: TimelineId;
  fromLsn: Lsn;
  toLsn: Lsn;
}

export interface TimelineSnapshotEntry {
  id: TimelineId;
  parentId: TimelineId | null;
  branchLsn: Lsn;
  sealed: boolean;
  segments: ArchiveSegment[];
}

export interface TimelineSnapshot {
  timelines: TimelineSnapshotEntry[];
}

export interface TimelineInfo extends TimelineSnapshotEntry {
  recoverableUpTo: Lsn;
}

interface TimelineNode {
  id: TimelineId;
  parentId: TimelineId | null;
  branchLsn: Lsn;
  sealed: boolean;
  segments: ArchiveSegment[];
}

function contiguousCoverage(segments: ArchiveSegment[], from: Lsn): Lsn {
  let cursor = from;
  for (const seg of segments) {
    if (seg.start > cursor) break;
    if (seg.end > cursor) cursor = seg.end;
  }
  return cursor;
}

export class TimelineStore {
  #nodes = new Map<TimelineId, TimelineNode>();

  createRoot(id: TimelineId): void {
    this.#assertFresh(id);
    this.#nodes.set(id, { id, parentId: null, branchLsn: 0, sealed: false, segments: [] });
  }

  createBranch(id: TimelineId, parentId: TimelineId, atLsn: Lsn): void {
    this.#assertFresh(id);
    const parent = this.#require(parentId);
    if (!parent.sealed) {
      throw new TimelineError(
        'PARENT_NOT_SEALED',
        `cannot branch from unsealed timeline "${parentId}"`,
      );
    }
    if (
      !Number.isInteger(atLsn) ||
      atLsn < parent.branchLsn ||
      !this.isRecoverable(parentId, atLsn)
    ) {
      throw new TimelineError(
        'INVALID_BRANCH_POINT',
        `lsn ${atLsn} is not a valid recoverable point on timeline "${parentId}"`,
      );
    }
    this.#nodes.set(id, { id, parentId, branchLsn: atLsn, sealed: false, segments: [] });
  }

  archiveSegment(id: TimelineId, start: Lsn, end: Lsn): void {
    const node = this.#require(id);
    if (node.sealed) {
      throw new TimelineError(
        'TIMELINE_SEALED',
        `timeline "${id}" is sealed and must not be rewritten`,
      );
    }
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      end <= start ||
      start < node.branchLsn
    ) {
      throw new TimelineError(
        'INVALID_SEGMENT',
        `segment [${start}, ${end}) is not valid on timeline "${id}" (branch point ${node.branchLsn})`,
      );
    }
    node.segments.push({ start, end });
    node.segments.sort((a, b) => a.start - b.start || a.end - b.end);
    const merged: ArchiveSegment[] = [];
    for (const seg of node.segments) {
      const last = merged[merged.length - 1];
      if (last && seg.start <= last.end) {
        if (seg.end > last.end) last.end = seg.end;
      } else {
        merged.push({ ...seg });
      }
    }
    node.segments = merged;
  }

  seal(id: TimelineId): void {
    this.#require(id).sealed = true;
  }

  isSealed(id: TimelineId): boolean {
    return this.#require(id).sealed;
  }

  has(id: TimelineId): boolean {
    return this.#nodes.has(id);
  }

  timelines(): TimelineId[] {
    return [...this.#nodes.keys()];
  }

  parentOf(id: TimelineId): { parentId: TimelineId; branchLsn: Lsn } | null {
    const node = this.#require(id);
    return node.parentId === null
      ? null
      : { parentId: node.parentId, branchLsn: node.branchLsn };
  }

  recoverableUpTo(id: TimelineId): Lsn {
    const chain = this.#chainToRoot(id);
    let up: Lsn = -1;
    for (const node of chain) {
      if (node.parentId === null) {
        up = contiguousCoverage(node.segments, 0);
      } else if (up >= node.branchLsn) {
        up = Math.max(node.branchLsn, contiguousCoverage(node.segments, node.branchLsn));
      }
    }
    return up;
  }

  isRecoverable(id: TimelineId, lsn: Lsn): boolean {
    if (!Number.isInteger(lsn) || lsn < 0) return false;
    return lsn <= this.recoverableUpTo(id);
  }

  recoveryPath(id: TimelineId, lsn: Lsn): RecoveryHop[] | null {
    if (!this.isRecoverable(id, lsn)) return null;
    const chain = this.#chainToRoot(id);
    return chain.map((node, index) => ({
      timelineId: node.id,
      fromLsn: node.branchLsn,
      toLsn: index + 1 < chain.length ? chain[index + 1].branchLsn : lsn,
    }));
  }

  findRecoverableTimelines(lsn: Lsn): TimelineId[] {
    return this.timelines().filter((id) => this.isRecoverable(id, lsn));
  }

  reachableFrom(id: TimelineId): TimelineId[] {
    this.#require(id);
    const children = new Map<TimelineId, TimelineId[]>();
    for (const node of this.#nodes.values()) {
      if (node.parentId !== null) {
        const list = children.get(node.parentId) ?? [];
        list.push(node.id);
        children.set(node.parentId, list);
      }
    }
    const result: TimelineId[] = [];
    const queue = [id];
    const seen = new Set<TimelineId>([id]);
    while (queue.length > 0) {
      const current = queue.shift() as TimelineId;
      for (const child of children.get(current) ?? []) {
        if (!seen.has(child)) {
          seen.add(child);
          result.push(child);
          queue.push(child);
        }
      }
    }
    return result;
  }

  info(id: TimelineId): TimelineInfo {
    const node = this.#require(id);
    return {
      id: node.id,
      parentId: node.parentId,
      branchLsn: node.branchLsn,
      sealed: node.sealed,
      segments: node.segments.map((seg) => ({ ...seg })),
      recoverableUpTo: this.recoverableUpTo(id),
    };
  }

  snapshot(): TimelineSnapshot {
    const timelines = [...this.#nodes.values()].map((node) => ({
      id: node.id,
      parentId: node.parentId,
      branchLsn: node.branchLsn,
      sealed: node.sealed,
      segments: node.segments.map((seg) => ({ ...seg })),
    }));
    timelines.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { timelines };
  }

  static restore(snapshot: TimelineSnapshot): TimelineStore {
    if (!snapshot || !Array.isArray(snapshot.timelines)) {
      throw new TimelineError('INVALID_SNAPSHOT', 'snapshot must contain a timelines array');
    }
    const store = new TimelineStore();
    const pending = new Map(snapshot.timelines.map((entry) => [entry.id, entry]));
    if (pending.size !== snapshot.timelines.length) {
      throw new TimelineError('INVALID_SNAPSHOT', 'snapshot contains duplicate timeline ids');
    }
    while (pending.size > 0) {
      let progressed = false;
      for (const [id, entry] of pending) {
        if (entry.parentId === null) {
          store.createRoot(id);
        } else {
          if (!store.has(entry.parentId)) continue;
          store.createBranch(id, entry.parentId, entry.branchLsn);
        }
        for (const seg of entry.segments) store.archiveSegment(id, seg.start, seg.end);
        if (entry.sealed) store.seal(id);
        pending.delete(id);
        progressed = true;
      }
      if (!progressed) {
        throw new TimelineError(
          'INVALID_SNAPSHOT',
          'snapshot contains a cycle or a missing parent timeline',
        );
      }
    }
    store.validate();
    return store;
  }

  validate(): void {
    for (const node of this.#nodes.values()) {
      this.#chainToRoot(node.id);
      if (node.parentId === null) {
        if (node.branchLsn !== 0) {
          throw new TimelineError('INVALID_SNAPSHOT', `root "${node.id}" has nonzero branch point`);
        }
      } else {
        const parent = this.#nodes.get(node.parentId);
        if (!parent) {
          throw new TimelineError('INVALID_SNAPSHOT', `timeline "${node.id}" has missing parent`);
        }
        if (!parent.sealed) {
          throw new TimelineError(
            'PARENT_NOT_SEALED',
            `timeline "${node.id}" branches from unsealed "${node.parentId}"`,
          );
        }
        if (node.branchLsn < parent.branchLsn) {
          throw new TimelineError(
            'INVALID_BRANCH_POINT',
            `timeline "${node.id}" branches below its parent's branch point`,
          );
        }
      }
      let prevEnd = -1;
      for (const seg of node.segments) {
        if (seg.start < node.branchLsn || seg.end <= seg.start || seg.start < prevEnd) {
          throw new TimelineError(
            'INVALID_SEGMENT',
            `timeline "${node.id}" holds malformed segment [${seg.start}, ${seg.end})`,
          );
        }
        prevEnd = seg.end;
      }
    }
  }

  #assertFresh(id: TimelineId): void {
    if (this.#nodes.has(id)) {
      throw new TimelineError('DUPLICATE_TIMELINE', `timeline "${id}" already exists`);
    }
  }

  #require(id: TimelineId): TimelineNode {
    const node = this.#nodes.get(id);
    if (!node) throw new TimelineError('UNKNOWN_TIMELINE', `unknown timeline "${id}"`);
    return node;
  }

  #chainToRoot(id: TimelineId): TimelineNode[] {
    const chain: TimelineNode[] = [];
    const seen = new Set<TimelineId>();
    let current = this.#require(id);
    for (;;) {
      if (seen.has(current.id)) {
        throw new TimelineError('CYCLE_DETECTED', `timeline graph has a cycle at "${current.id}"`);
      }
      seen.add(current.id);
      chain.unshift(current);
      if (current.parentId === null) return chain;
      current = this.#require(current.parentId);
    }
  }
}
