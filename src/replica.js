import { createHash } from 'node:crypto';

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    parts.push(JSON.stringify(key) + ':' + canonical(value[key]));
  }
  return '{' + parts.join(',') + '}';
}

export function eventId(event) {
  const { id, ...rest } = event;
  return createHash('sha256').update(canonical(rest)).digest('hex');
}

export function issuerOf(event) {
  return event.type === 'freeze' || event.type === 'release' ? event.memberId : event.by;
}

export class Replica {
  constructor(state) {
    this.state = state;
  }

  static init({ account, total, memberId }) {
    return new Replica({
      accounts: { [account]: { total, frozen: 0 } },
      members: { [memberId]: { active: true } },
      epoch: 0,
      events: {},
      frontier: { [memberId]: null },
      requests: {},
    });
  }

  static fromJSON(json) {
    return new Replica(JSON.parse(JSON.stringify(json)));
  }

  toJSON() {
    return this.state;
  }

  createEvent(type, payload) {
    const event = { type, ...payload, epoch: this.state.epoch };
    const issuer = issuerOf(event);
    event.prevHash = this.state.frontier[issuer] ?? null;
    event.id = eventId(event);
    return event;
  }

  chainSatisfied(event) {
    const issuer = issuerOf(event);
    return (event.prevHash ?? null) === (this.state.frontier[issuer] ?? null);
  }

  applyEvent(event) {
    const id = event.id ?? eventId(event);
    if (this.state.events[id]) return { ok: true, id, duplicate: true };
    const issuer = issuerOf(event);
    if ((event.prevHash ?? null) !== (this.state.frontier[issuer] ?? null)) {
      return { error: 'missing-prev', id };
    }
    const member = this.state.members[issuer];
    if (!member || !member.active) return { error: 'stale-member', id };
    if (event.epoch !== this.state.epoch) return { error: 'stale-epoch', id };

    switch (event.type) {
      case 'freeze': {
        const acct = this.state.accounts[event.account];
        if (!acct) return { error: 'unknown-account', id };
        if (this.state.requests[event.requestId]) return { error: 'duplicate-request', id };
        if (acct.frozen + event.amount > acct.total) return { error: 'limit-exceeded', id };
        acct.frozen += event.amount;
        this.state.requests[event.requestId] = {
          account: event.account,
          amount: event.amount,
          released: false,
        };
        break;
      }
      case 'release': {
        const req = this.state.requests[event.requestId];
        if (!req || req.released) return { error: 'unknown-request', id };
        if (event.amount !== req.amount) return { error: 'amount-mismatch', id };
        req.released = true;
        this.state.accounts[req.account].frozen -= req.amount;
        break;
      }
      case 'add-member': {
        const target = this.state.members[event.member];
        if (target && target.active) return { error: 'member-exists', id };
        this.state.members[event.member] = { active: true };
        this.state.frontier[event.member] = this.state.frontier[event.member] ?? null;
        this.state.epoch += 1;
        break;
      }
      case 'remove-member': {
        const target = this.state.members[event.member];
        if (!target || !target.active) return { error: 'unknown-member', id };
        const observed = event.frontier ? event.frontier[event.member] : undefined;
        if (observed === undefined || observed !== (this.state.frontier[event.member] ?? null)) {
          return { error: 'remove-incomplete', id };
        }
        target.active = false;
        this.state.epoch += 1;
        break;
      }
      default:
        return { error: 'unknown-event', id };
    }

    event.id = id;
    this.state.events[id] = event;
    this.state.frontier[issuer] = id;
    return { ok: true, id };
  }

  freeze({ requestId, account, amount, memberId }) {
    return this.applyEvent(this.createEvent('freeze', { requestId, account, amount, memberId }));
  }

  release({ requestId, memberId, amount }) {
    const req = this.state.requests[requestId];
    const resolved = amount ?? (req && req.amount);
    return this.applyEvent(this.createEvent('release', { requestId, amount: resolved, memberId }));
  }

  addMember({ member, by }) {
    return this.applyEvent(this.createEvent('add-member', { member, by }));
  }

  removeMember({ member, by, frontier }) {
    const observed = frontier ?? { ...this.state.frontier };
    return this.applyEvent(this.createEvent('remove-member', { member, by, frontier: observed }));
  }

  merge(incoming) {
    const events = eventList(incoming);
    const pending = new Map();
    for (const event of events) {
      const id = event.id ?? eventId(event);
      if (!this.state.events[id]) pending.set(id, event);
    }
    const applied = [];
    const rejected = [];
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [id, event] of [...pending]) {
        if (!this.chainSatisfied(event)) continue;
        const res = this.applyEvent(event);
        if (res.ok) {
          applied.push(id);
          pending.delete(id);
          progressed = true;
        }
      }
    }
    for (const [id, event] of [...pending]) {
      if (!this.chainSatisfied(event)) continue;
      const res = this.applyEvent(event);
      rejected.push({ id, error: res.error });
      pending.delete(id);
    }
    for (const id of pending.keys()) rejected.push({ id, error: 'missing-prev' });
    return { applied, rejected };
  }

  diff(other) {
    const missingFreezes = [];
    const missingReleases = [];
    const missingMembers = [];
    for (const event of eventList(other)) {
      const id = event.id ?? eventId(event);
      if (this.state.events[id]) continue;
      if (event.type === 'freeze') missingFreezes.push(id);
      else if (event.type === 'release') missingReleases.push(id);
      else if (event.type === 'add-member' || event.type === 'remove-member') missingMembers.push(id);
    }
    return { missingFreezes, missingReleases, missingMembers };
  }

  summary() {
    return {
      epoch: this.state.epoch,
      frontier: this.state.frontier,
      accounts: this.state.accounts,
      members: this.state.members,
      eventIds: Object.keys(this.state.events),
    };
  }
}

function eventList(source) {
  const events = Array.isArray(source) ? source : source.events;
  if (!events) return [];
  return Array.isArray(events) ? events : Object.values(events);
}
