import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256hex, DomainError, VerifyError } from './util.js';
import { computeSchedule } from './scheduler.js';

const GENESIS = '0'.repeat(64);

export function initState() {
  return { config: null, passes: [], tasks: {} };
}

// Applies one journal entry to `state`. With recompute=false the entry payload
// may be enriched (derived fields like `confirmed`); with recompute=true the
// stored derived fields are checked and a mismatch raises VerifyError.
export function applyEntry(state, entry, { recompute = false } = {}) {
  const { op, payload } = entry;
  switch (op) {
    case 'init':
      state.config = { ...payload };
      break;
    case 'pass': {
      const p = payload.pass;
      if (typeof p.elevation !== 'number' || p.elevation < 0) {
        throw new DomainError(`negative elevation on pass ${p.id}`);
      }
      if (p.rate > state.config.maxRate) {
        throw new DomainError(`rate ${p.rate} exceeds link max ${state.config.maxRate}`);
      }
      if (p.end <= p.start) throw new DomainError(`pass ${p.id} has an empty window`);
      if (state.passes.some((x) => x.id === p.id)) {
        throw new DomainError(`duplicate pass id ${p.id}`);
      }
      state.passes.push({ ...p, corrections: [] });
      const t = state.tasks[p.task] ?? {};
      if (payload.task?.quota !== undefined) t.quota = payload.task.quota;
      if (payload.task?.minGuarantee !== undefined) t.minGuarantee = payload.task.minGuarantee;
      state.tasks[p.task] = t;
      break;
    }
    case 'correct': {
      const pass = state.passes.find((x) => x.id === payload.pass);
      if (!pass) throw new DomainError(`unknown pass ${payload.pass}`);
      const corr = {
        start: payload.start,
        end: payload.end,
        at: payload.at,
        pending: !!payload.pending,
      };
      pass.corrections.push(corr);
      // Bytes on the ground before `at` are confirmed by this correction.
      const confirmed = computeSchedule(state).segments.filter((s) => s.end <= corr.at);
      if (recompute) {
        if (canonical(confirmed) !== canonical(payload.confirmed ?? [])) {
          throw new VerifyError(`confirmed-bytes mismatch at seq ${entry.seq}`);
        }
      } else {
        payload.confirmed = confirmed;
      }
      break;
    }
    case 'confirm': {
      const pass = state.passes.find((x) => x.id === payload.pass);
      if (!pass) throw new DomainError(`unknown pass ${payload.pass}`);
      let found = false;
      for (const c of pass.corrections) {
        if (c.pending) {
          c.pending = false;
          found = true;
        }
      }
      if (!found) throw new DomainError(`no pending correction for ${payload.pass}`);
      break;
    }
    default:
      throw new VerifyError(`unknown op ${op}`);
  }
}

// Deterministic replay: undo entries deactivate their targets, everything else
// applies in seq order.
export function replay(entries) {
  const inactive = new Set();
  for (const e of entries) {
    if (e.op === 'undo') for (const s of e.payload.removed) inactive.add(s);
  }
  const state = initState();
  for (const e of entries) {
    if (e.op === 'undo' || inactive.has(e.seq)) continue;
    applyEntry(state, e, { recompute: true });
  }
  return state;
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.journal = join(dir, 'journal.log');
  }

  exists() {
    return existsSync(this.journal);
  }

  rawLines() {
    if (!this.exists()) return [];
    return readFileSync(this.journal, 'utf8').split('\n').filter((l) => l.length > 0);
  }

  readEntries() {
    return this.rawLines().map((l) => JSON.parse(l));
  }

  state() {
    return replay(this.readEntries());
  }

  head() {
    const entries = this.readEntries();
    if (entries.length === 0) return { seq: 0, hash: GENESIS };
    const last = entries[entries.length - 1];
    return { seq: last.seq, hash: last.hash };
  }

  ensureInit(config) {
    if (!this.exists()) {
      mkdirSync(this.dir, { recursive: true });
      this.append('init', { ...config });
    }
  }

  append(op, payload) {
    const entries = this.readEntries();
    const base = replay(entries);
    const seq = entries.length === 0 ? 1 : entries[entries.length - 1].seq + 1;
    const prev = entries.length === 0 ? GENESIS : entries[entries.length - 1].hash;
    const entry = { seq, op, payload, prev };
    if (op !== 'undo') applyEntry(base, entry, { recompute: false }); // validates + enriches
    const state = replay([...entries, entry]);
    entry.state = sha256hex(canonical(state));
    entry.hash = sha256hex(
      prev + '\n' + canonical({ seq, op, payload: entry.payload, prev, state: entry.state })
    );
    mkdirSync(this.dir, { recursive: true });
    appendFileSync(this.journal, canonical(entry) + '\n');
    return entry;
  }

  // Multi-level undo. Either `steps` (pop n entries) or `toPass` (pop back to
  // just before the latest entry touching that pass). Refuses with DomainError
  // (exit 9) if any removed entry carries confirmed bytes.
  undo({ steps, toPass } = {}) {
    const entries = this.readEntries();
    const inactive = new Set();
    for (const e of entries) {
      if (e.op === 'undo') for (const s of e.payload.removed) inactive.add(s);
    }
    const active = entries.filter((e) => e.op !== 'undo' && !inactive.has(e.seq));
    let cut;
    if (toPass !== undefined) {
      cut = -1;
      for (let i = 0; i < active.length; i++) {
        const e = active[i];
        const pid =
          e.op === 'pass'
            ? e.payload.pass?.id
            : e.op === 'correct' || e.op === 'confirm'
              ? e.payload.pass
              : undefined;
        if (pid === toPass) cut = i;
      }
      if (cut === -1) throw new DomainError(`no journal entry for pass ${toPass}`);
    } else {
      const n = steps ?? 1;
      if (!Number.isInteger(n) || n < 1 || n > active.length - 1) {
        throw new DomainError(`cannot undo ${n} step(s); ${active.length - 1} removable`);
      }
      cut = active.length - n;
    }
    if (cut <= 0) throw new DomainError('cannot undo the init entry');
    const removed = active.slice(cut);
    for (const e of removed) {
      if (e.op === 'correct' && (e.payload.confirmed?.length ?? 0) > 0) {
        throw new DomainError(`undo would revert confirmed bytes (seq ${e.seq})`);
      }
    }
    return this.append('undo', { removed: removed.map((e) => e.seq) });
  }

  // Verifies the hash chain and replays every prefix. Returns a report; never
  // throws on corrupt data.
  verify() {
    const lines = this.rawLines();
    const entries = [];
    let prev = GENESIS;
    for (let i = 0; i < lines.length; i++) {
      let e;
      try {
        e = JSON.parse(lines[i]);
      } catch {
        return { ok: false, badLine: i + 1, reason: 'unparseable (truncated write?)', good: i };
      }
      const fail = (reason) => ({ ok: false, badLine: i + 1, reason, good: i });
      if (e.seq !== i + 1) return fail(`bad seq ${e.seq}`);
      if (e.prev !== prev) return fail('broken prev link');
      const expect = sha256hex(
        prev + '\n' + canonical({ seq: e.seq, op: e.op, payload: e.payload, prev: e.prev, state: e.state })
      );
      if (e.hash !== expect) return fail('hash mismatch');
      try {
        const st = replay([...entries, e]);
        if (sha256hex(canonical(st)) !== e.state) return fail('state hash mismatch');
      } catch (err) {
        return fail(`replay failed: ${err.message}`);
      }
      entries.push(e);
      prev = e.hash;
    }
    return {
      ok: true,
      entries: entries.length,
      head: prev,
      state: entries.length === 0 ? null : entries[entries.length - 1].state,
    };
  }

  // Truncates the journal to the longest valid prefix.
  recover() {
    const lines = this.rawLines();
    const report = this.verify();
    if (report.ok) return { removed: 0 };
    const kept = lines.slice(0, report.good);
    writeFileSync(this.journal, kept.map((l) => l + '\n').join(''));
    return { removed: lines.length - report.good };
  }
}
