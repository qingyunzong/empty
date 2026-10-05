export interface SessionEvent {
  id: string;
  userId: string;
  timestamp: number;
}

export interface Session {
  /** 会话 ID：成员事件的最小 ID */
  id: string;
  userId: string;
  start: number;
  end: number;
  count: number;
  /** 按 (timestamp, id) 排序的成员事件 ID */
  memberIds: string[];
}

export type SessionOp =
  | { type: "add"; event: SessionEvent }
  | { type: "remove"; eventId: string }
  | { type: "update"; eventId: string; timestamp: number };

export interface SessionChange {
  before: Session;
  after: Session;
}

/** 相对上一次 commit（或初始状态）的净差分 */
export interface SessionDiff {
  added: Session[];
  removed: Session[];
  changed: SessionChange[];
}

interface InternalSession {
  /** 按 (timestamp, id) 排序，与所属用户的 order 子序列一致 */
  ids: string[];
}

interface UserState {
  /** 该用户全部事件 ID，按 (timestamp, id) 排序 */
  order: string[];
  sessions: Set<InternalSession>;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const KEY_SEP = "|";

export class SessionStore {
  private readonly gap: number;
  private readonly events = new Map<string, SessionEvent>();
  private readonly users = new Map<string, UserState>();
  private readonly sessionOf = new Map<string, InternalSession>();
  private baseline = new Map<string, Session>();

  constructor(gapMs: number) {
    if (!Number.isFinite(gapMs) || gapMs < 0) {
      throw new Error("gap must be a non-negative finite number");
    }
    this.gap = gapMs;
  }

  /** 乱序应用一批增/删/改操作 */
  apply(ops: Iterable<SessionOp>): void {
    for (const op of ops) {
      switch (op.type) {
        case "add":
          this.addEvent(op.event);
          break;
        case "remove":
          this.removeEvent(op.eventId);
          break;
        case "update":
          this.updateEventTime(op.eventId, op.timestamp);
          break;
      }
    }
  }

  addEvent(event: SessionEvent): void {
    if (this.events.has(event.id)) {
      throw new Error(`duplicate event id: ${event.id}`);
    }
    this.events.set(event.id, event);
    const us = this.userState(event.userId);
    const pos = this.lowerBound(us, event);
    us.order.splice(pos, 0, event.id);

    const prevId = pos > 0 ? us.order[pos - 1] : undefined;
    const nextId = pos + 1 < us.order.length ? us.order[pos + 1] : undefined;
    const prev = prevId !== undefined ? this.mustGet(prevId) : undefined;
    const next = nextId !== undefined ? this.mustGet(nextId) : undefined;
    const joinLeft =
      prev !== undefined && event.timestamp - prev.timestamp <= this.gap;
    const joinRight =
      next !== undefined && next.timestamp - event.timestamp <= this.gap;

    if (joinLeft && joinRight) {
      const left = this.sessionOf.get(prev.id)!;
      const right = this.sessionOf.get(next.id)!;
      if (left === right) {
        // 新事件落在同一会话内部，按 (timestamp, id) 有序插入
        left.ids.splice(this.insertPos(left, event), 0, event.id);
      } else {
        left.ids.push(event.id, ...right.ids);
        us.sessions.delete(right);
        for (const id of right.ids) this.sessionOf.set(id, left);
      }
      this.sessionOf.set(event.id, left);
    } else if (joinLeft) {
      const left = this.sessionOf.get(prev.id)!;
      left.ids.push(event.id);
      this.sessionOf.set(event.id, left);
    } else if (joinRight) {
      const right = this.sessionOf.get(next.id)!;
      right.ids.unshift(event.id);
      this.sessionOf.set(event.id, right);
    } else {
      const fresh: InternalSession = { ids: [event.id] };
      us.sessions.add(fresh);
      this.sessionOf.set(event.id, fresh);
    }
  }

  removeEvent(eventId: string): void {
    const event = this.events.get(eventId);
    if (!event) throw new Error(`unknown event id: ${eventId}`);
    const us = this.users.get(event.userId)!;
    const session = this.sessionOf.get(eventId)!;

    us.order.splice(this.indexOf(us, event), 1);
    session.ids.splice(this.indexOfIds(session, event), 1);
    this.sessionOf.delete(eventId);
    this.events.delete(eventId);

    if (session.ids.length === 0) {
      us.sessions.delete(session);
    } else {
      // 删除中间事件至多产生一个超过 gap 的新间隔，即至多分裂为两段
      const ids = session.ids;
      const runs: string[][] = [];
      let runStart = 0;
      for (let i = 1; i <= ids.length; i++) {
        const isBoundary =
          i === ids.length ||
          this.mustGet(ids[i]!).timestamp - this.mustGet(ids[i - 1]!).timestamp >
            this.gap;
        if (isBoundary) {
          runs.push(ids.slice(runStart, i));
          runStart = i;
        }
      }
      session.ids = runs[0]!;
      for (let r = 1; r < runs.length; r++) {
        const split: InternalSession = { ids: runs[r]! };
        us.sessions.add(split);
        for (const id of split.ids) this.sessionOf.set(id, split);
      }
    }

    if (us.order.length === 0) this.users.delete(event.userId);
  }

  /** 更正事件时间：等价于删除后按新时间重新插入，可能触发合并或分裂 */
  updateEventTime(eventId: string, timestamp: number): void {
    const event = this.events.get(eventId);
    if (!event) throw new Error(`unknown event id: ${eventId}`);
    const userId = event.userId;
    this.removeEvent(eventId);
    this.addEvent({ id: eventId, userId, timestamp });
  }

  /** 当前全部会话（增量维护的结果），按 (userId, start, id) 排序 */
  sessions(userId?: string): Session[] {
    const result: Session[] = [];
    if (userId !== undefined) {
      const us = this.users.get(userId);
      if (us) for (const s of us.sessions) result.push(this.materialize(userId, s));
    } else {
      for (const [uid, us] of this.users) {
        for (const s of us.sessions) result.push(this.materialize(uid, s));
      }
    }
    return sortSessions(result);
  }

  /** 将当前状态设为差分基线 */
  commit(): void {
    this.baseline = this.snapshotOf(this.sessions());
  }

  /** 当前状态相对基线的净差分（先增后删的会话不出现，最小 ID 变化体现为 删+增） */
  diff(): SessionDiff {
    const current = this.snapshotOf(this.sessions());
    const added: Session[] = [];
    const removed: Session[] = [];
    const changed: SessionChange[] = [];
    for (const [key, after] of current) {
      const before = this.baseline.get(key);
      if (!before) added.push(after);
      else if (signature(before) !== signature(after)) changed.push({ before, after });
    }
    for (const [key, before] of this.baseline) {
      if (!current.has(key)) removed.push(before);
    }
    return {
      added: sortSessions(added),
      removed: sortSessions(removed),
      changed: sortChanges(changed),
    };
  }

  /** 参考实现：从原始事件全量排序重建会话，用于核对增量结果 */
  rebuild(): Session[] {
    return SessionStore.rebuildSessions(this.events.values(), this.gap);
  }

  static rebuildSessions(events: Iterable<SessionEvent>, gapMs: number): Session[] {
    const byUser = new Map<string, SessionEvent[]>();
    for (const e of events) {
      const list = byUser.get(e.userId);
      if (list) list.push(e);
      else byUser.set(e.userId, [e]);
    }
    const result: Session[] = [];
    for (const [userId, list] of byUser) {
      list.sort(
        (a, b) => a.timestamp - b.timestamp || compareIds(a.id, b.id),
      );
      let run: SessionEvent[] = [];
      const flush = (): void => {
        if (run.length === 0) return;
        result.push(buildSession(userId, run));
        run = [];
      };
      for (const e of list) {
        const last = run[run.length - 1];
        if (last && e.timestamp - last.timestamp > gapMs) flush();
        run.push(e);
      }
      flush();
    }
    return sortSessions(result);
  }

  /** 核对增量维护结果与排序重建结果一致，不一致则抛出差异详情 */
  verify(): void {
    const incremental = this.sessions();
    const rebuilt = this.rebuild();
    const a = incremental.map(signature);
    const b = rebuilt.map(signature);
    if (a.length !== b.length || a.some((s, i) => s !== b[i])) {
      throw new Error(
        `incremental/rebuild mismatch\nincremental: ${JSON.stringify(incremental)}\nrebuilt: ${JSON.stringify(rebuilt)}`,
      );
    }
  }

  private userState(userId: string): UserState {
    let us = this.users.get(userId);
    if (!us) {
      us = { order: [], sessions: new Set() };
      this.users.set(userId, us);
    }
    return us;
  }

  private mustGet(eventId: string): SessionEvent {
    return this.events.get(eventId)!;
  }

  private compareAt(us: UserState, index: number, event: SessionEvent): number {
    const other = this.mustGet(us.order[index]!);
    return (
      other.timestamp - event.timestamp || compareIds(other.id, event.id)
    );
  }

  private lowerBound(us: UserState, event: SessionEvent): number {
    let lo = 0;
    let hi = us.order.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.compareAt(us, mid, event) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private indexOf(us: UserState, event: SessionEvent): number {
    const pos = this.lowerBound(us, event);
    if (pos >= us.order.length || us.order[pos] !== event.id) {
      throw new Error(`event not found in user order: ${event.id}`);
    }
    return pos;
  }

  private indexOfIds(session: InternalSession, event: SessionEvent): number {
    const pos = this.insertPos(session, event);
    if (pos >= session.ids.length || session.ids[pos] !== event.id) {
      throw new Error(`event not found in session: ${event.id}`);
    }
    return pos;
  }

  private insertPos(session: InternalSession, event: SessionEvent): number {
    let lo = 0;
    let hi = session.ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const other = this.mustGet(session.ids[mid]!);
      const cmp =
        other.timestamp - event.timestamp || compareIds(other.id, event.id);
      if (cmp < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private materialize(userId: string, session: InternalSession): Session {
    return buildSession(
      userId,
      session.ids.map((id) => this.mustGet(id)),
    );
  }

  private snapshotOf(sessions: Session[]): Map<string, Session> {
    const map = new Map<string, Session>();
    for (const s of sessions) map.set(s.userId + KEY_SEP + s.id, s);
    return map;
  }
}

function buildSession(userId: string, members: SessionEvent[]): Session {
  let minId = members[0]!.id;
  for (const m of members) if (compareIds(m.id, minId) < 0) minId = m.id;
  return {
    id: minId,
    userId,
    start: members[0]!.timestamp,
    end: members[members.length - 1]!.timestamp,
    count: members.length,
    memberIds: members.map((m) => m.id),
  };
}

function signature(s: Session): string {
  return JSON.stringify(s);
}

function sortSessions(sessions: Session[]): Session[] {
  return sessions.sort(
    (a, b) =>
      compareIds(a.userId, b.userId) ||
      a.start - b.start ||
      compareIds(a.id, b.id),
  );
}

function sortChanges(changes: SessionChange[]): SessionChange[] {
  return changes.sort(
    (a, b) =>
      compareIds(a.after.userId, b.after.userId) ||
      a.after.start - b.after.start ||
      compareIds(a.after.id, b.after.id),
  );
}
