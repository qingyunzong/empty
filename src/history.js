import { ReconError } from './errors.js';

// Total order for linearization: lamport, then source id, then source sequence.
export function compareEvents(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.seq - b.seq;
}

function domainState() {
  return { sealed: false, events: [], head: null };
}

// A conflict domain is (account, day). All repairs touching the same
// account on the same day are linearized here.
export class History {
  constructor() {
    this.domains = new Map();
  }

  static domainKey(account, day) {
    return `${account}@${day}`;
  }

  domain(account, day) {
    const key = History.domainKey(account, day);
    let d = this.domains.get(key);
    if (!d) {
      d = domainState();
      this.domains.set(key, d);
    }
    return d;
  }

  seal(account, day) {
    this.domain(account, day).sealed = true;
  }

  isSealed(account, day) {
    return this.domain(account, day).sealed;
  }

  headId(account, day) {
    const head = this.domain(account, day).head;
    return head ? head.id : null;
  }

  // event: { id, account, day, lamport, source, seq, kind, supersedes? }
  // Rules:
  //  - sealed domain: only an event that supersedes the current head may be
  //    recorded (supersedes chain); anything else -> SEALED.
  //  - unsealed domain with a head: the event must be a clean continuation
  //    (same source, monotonic lamport + seq) or explicitly supersede the
  //    head; otherwise it is concurrent -> CONFLICT_DOMAIN.
  record(event) {
    for (const f of ['id', 'account', 'day', 'lamport', 'source', 'seq']) {
      if (event[f] === undefined) throw new ReconError('BAD_DIFF', `history event missing "${f}"`);
    }
    const d = this.domain(event.account, event.day);
    const head = d.head;
    const supersedesHead = head !== null && event.supersedes === head.id;

    if (d.sealed && !supersedesHead) {
      throw new ReconError(
        'SEALED',
        `domain ${History.domainKey(event.account, event.day)} is sealed; event ${event.id} does not extend the supersedes chain`,
        { domain: History.domainKey(event.account, event.day), event: event.id },
      );
    }
    if (head !== null && !supersedesHead) {
      const continuation =
        event.source === head.source && event.lamport > head.lamport && event.seq > head.seq;
      if (!continuation) {
        throw new ReconError(
          'CONFLICT_DOMAIN',
          `event ${event.id} is concurrent with head ${head.id} in domain ${History.domainKey(event.account, event.day)}`,
          { domain: History.domainKey(event.account, event.day), event: event.id, head: head.id },
        );
      }
    }
    d.events.push(event);
    d.head = event;
    return event;
  }

  // Linearized view of one domain: lamport, then source, then seq.
  linearize(account, day) {
    return [...this.domain(account, day).events].sort(compareEvents);
  }
}
