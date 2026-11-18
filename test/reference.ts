/**
 * Deliberately small, independent reference model used by the differential
 * test. It recomputes readiness from member records on every query instead of
 * maintaining a ready set or selection cache.
 */

export type RefState = "connecting" | "ready" | "reconnecting" | "closed";

export interface RefBackoff {
  baseMs: number;
  factor: number;
  maxMs: number;
}

interface RefMember {
  id: string;
  state: RefState;
  attempt: number;
  failures: number;
  retryAt: number | null;
  checking: boolean;
  checkToken: number;
}

export interface RefTicket {
  id: string;
  attempt: number;
  token: number;
}

export interface RefMemberSnapshot {
  id: string;
  state: RefState;
  attempt: number;
  failures: number;
  retryAt: number | null;
  checking: boolean;
  checkToken: number;
}

export interface RefSnapshot {
  now: number;
  readyIds: string[];
  readyCount: number;
  availableIds: string[];
  members: RefMemberSnapshot[];
}

function cmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function delayFor(failures: number, backoff: RefBackoff): number {
  return Math.min(
    backoff.maxMs,
    backoff.baseMs * Math.pow(backoff.factor, failures - 1),
  );
}

function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class ReferencePool {
  now = 0;
  readonly backoff: RefBackoff;
  readonly members = new Map<string, RefMember>();
  lastSelectedId: string | null = null;

  constructor(backoff: Partial<RefBackoff> = {}) {
    this.backoff = {
      baseMs: backoff.baseMs ?? 100,
      factor: backoff.factor ?? 2,
      maxMs: backoff.maxMs ?? 30_000,
    };
  }

  add(id: string): { id: string; attempt: number; at: number } {
    if (this.members.has(id)) {
      throw new Error(`duplicate ${id}`);
    }
    this.members.set(id, {
      id,
      state: "connecting",
      attempt: 1,
      failures: 0,
      retryAt: null,
      checking: false,
      checkToken: 0,
    });
    return { id, attempt: 1, at: this.now };
  }

  get(id: string): RefMemberSnapshot | undefined {
    const member = this.members.get(id);
    if (member === undefined) return undefined;
    return {
      id: member.id,
      state: member.state,
      attempt: member.attempt,
      failures: member.failures,
      retryAt: member.retryAt,
      checking: member.checking,
      checkToken: member.checkToken,
    };
  }

  attemptOf(id: string): number | null {
    return this.members.get(id)?.attempt ?? null;
  }

  connected(id: string, attempt: number): boolean {
    const member = this.members.get(id);
    if (!member) return false;
    if (member.state !== "connecting") return false;
    if (member.attempt !== attempt) return false;
    member.state = "ready";
    member.failures = 0;
    member.retryAt = null;
    member.checking = false;
    member.checkToken = member.checkToken + 1;
    return true;
  }

  failed(id: string, attempt: number): boolean {
    const member = this.members.get(id);
    if (!member) return false;
    if (member.attempt !== attempt) return false;
    if (member.state !== "connecting" && member.state !== "ready") return false;

    if (member.state === "ready") {
      member.failures = 1;
    } else {
      member.failures = member.failures + 1;
    }
    member.state = "reconnecting";
    member.retryAt = this.now + delayFor(member.failures, this.backoff);
    member.checking = false;
    member.checkToken = member.checkToken + 1;
    return true;
  }

  advanceTo(time: number): { id: string; attempt: number; at: number }[] {
    this.now = time;
    const pending: RefMember[] = [];
    for (const member of this.members.values()) {
      if (member.state !== "reconnecting") continue;
      if (member.retryAt === null) continue;
      if (member.retryAt > time) continue;
      pending.push(member);
    }
    pending.sort((a, b) => {
      const byTime = (a.retryAt as number) - (b.retryAt as number);
      return byTime !== 0 ? byTime : cmp(a.id, b.id);
    });

    const result: { id: string; attempt: number; at: number }[] = [];
    for (const member of pending) {
      member.state = "connecting";
      member.attempt = member.attempt + 1;
      member.retryAt = null;
      member.checkToken = member.checkToken + 1;
      result.push({ id: member.id, attempt: member.attempt, at: time });
    }
    return result;
  }

  advance(ms: number): { id: string; attempt: number; at: number }[] {
    return this.advanceTo(this.now + ms);
  }

  beginHealthCheck(id: string): RefTicket | null {
    const member = this.members.get(id);
    if (!member) return null;
    if (member.state !== "ready") return null;
    if (member.checking) return null;
    member.checking = true;
    member.checkToken = member.checkToken + 1;
    return {
      id,
      attempt: member.attempt,
      token: member.checkToken,
    };
  }

  completeHealthCheck(ticket: RefTicket, healthy: boolean): boolean {
    const member = this.members.get(ticket.id);
    if (!member) return false;
    if (member.state !== "ready") return false;
    if (!member.checking) return false;
    if (member.attempt !== ticket.attempt) return false;
    if (member.checkToken !== ticket.token) return false;

    member.checking = false;
    member.checkToken = member.checkToken + 1;
    if (healthy) return true;

    member.failures = 1;
    member.state = "reconnecting";
    member.retryAt = this.now + delayFor(1, this.backoff);
    return true;
  }

  readyIds(): string[] {
    return [...this.members.values()]
      .filter((member) => member.state === "ready")
      .sort((a, b) => cmp(a.id, b.id))
      .map((member) => member.id);
  }

  select(): string | null {
    const all = [...this.members.values()].sort((a, b) => cmp(a.id, b.id));
    if (all.length === 0) return null;

    let start = 0;
    if (this.lastSelectedId !== null) {
      const found = all.findIndex((member) => member.id === this.lastSelectedId);
      start = found < 0 ? 0 : found + 1;
    }
    for (let offset = 0; offset < all.length; offset += 1) {
      const member = all[(start + offset) % all.length];
      if (member.state === "ready") {
        this.lastSelectedId = member.id;
        return member.id;
      }
    }
    return null;
  }

  selectForKey(key: string): string | null {
    const ids = this.readyIds();
    if (ids.length === 0) return null;
    let best = ids[0];
    let bestScore = stableHash(`${key}\u0000${best}`);
    for (const id of ids.slice(1)) {
      const score = stableHash(`${key}\u0000${id}`);
      if (score > bestScore || (score === bestScore && id < best)) {
        best = id;
        bestScore = score;
      }
    }
    return best;
  }

  snapshot(): RefSnapshot {
    const members = [...this.members.values()]
      .sort((a, b) => cmp(a.id, b.id))
      .map((member) => ({
        id: member.id,
        state: member.state,
        attempt: member.attempt,
        failures: member.failures,
        retryAt: member.retryAt,
        checking: member.checking,
        checkToken: member.checkToken,
      }));
    const readyIds = members
      .filter((member) => member.state === "ready")
      .map((member) => member.id);
    return {
      now: this.now,
      readyIds,
      readyCount: readyIds.length,
      availableIds: readyIds,
      members,
    };
  }
}
