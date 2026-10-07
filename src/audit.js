import { createHash } from 'node:crypto';

export const REPORT_VERSION = 1;

// Hash domain-separation tags: window head, event, appendix, root chain.
export const TAGS = Object.freeze({
  WHDR: 'WHDR',
  WEVT: 'WEVT',
  APPX: 'APPX',
  ROOT: 'ROOT',
});

function sha256hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

// Deterministic canonical JSON (sorted object keys) for stable hashing.
export function canon(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

export function hashDomain(tag, payload) {
  return sha256hex(tag + ' ' + payload);
}

function windowHeadHash(start, end) {
  return hashDomain(TAGS.WHDR, canon({ start, end }));
}

function eventRecordOf(e, contribution) {
  return {
    seq: e.seq,
    eventTime: e.eventTime,
    type: e.type,
    acct: e.acct ?? null,
    amount: e.amount ?? 0,
    ref: e.ref ?? null,
    contribution,
  };
}

function eventLeafHash(rec) {
  return hashDomain(TAGS.WEVT, canon(rec));
}

function appendixLeafHash(entry) {
  const { hash, ...fields } = entry;
  return hashDomain(TAGS.APPX, canon(fields));
}

function foldWindowEvent(windowHash, eventHash) {
  return hashDomain(TAGS.WEVT, windowHash + ':' + eventHash);
}

function computeRoot({ version, params, windows, appendix, errors }) {
  let root = hashDomain(
    TAGS.ROOT,
    canon({ version, windowSize: params.windowSize, allowedLateness: params.allowedLateness }),
  );
  for (const w of windows) root = hashDomain(TAGS.ROOT, root + ':' + w.hash);
  for (const a of appendix) root = hashDomain(TAGS.APPX, root + ':' + a.hash);
  root = hashDomain(TAGS.ROOT, root + ':' + canon(errors));
  return root;
}

// Independent O(n^2) recomputation of one event's amount contribution by
// replaying the whole version history from scratch (used by --naive).
function naiveContribution(sorted, index) {
  const versions = new Map();
  let contribution = 0;
  for (let j = 0; j <= index; j += 1) {
    const e = sorted[j];
    if (e.type === 'append') {
      versions.set(e.seq, { effective: e.amount ?? 0 });
      if (j === index) contribution = e.amount ?? 0;
    } else if (e.type === 'correct') {
      const target = versions.get(e.ref);
      if (typeof e.ref === 'number' && e.ref < e.seq && target) {
        if (j === index) contribution = (e.amount ?? 0) - target.effective;
        target.effective = e.amount ?? 0;
      }
    }
  }
  return contribution;
}

export class NaiveMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NaiveMismatchError';
  }
}

export function buildReport(events, opts = {}) {
  const windowSize = opts.windowSize ?? 3_600_000;
  const allowedLateness = opts.allowedLateness ?? 0;
  if (!Number.isFinite(windowSize) || windowSize <= 0) {
    throw new Error('windowSize must be a positive number');
  }
  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  const windows = new Map();
  const appendix = [];
  const errors = [];
  const versions = new Map(); // target seq -> { effective, chain: [seq, ...] }
  const contributions = new Array(sorted.length).fill(0);
  const inAppendix = new Array(sorted.length).fill(false);
  let maxEventTime = null;

  for (let i = 0; i < sorted.length; i += 1) {
    const e = sorted[i];
    if (maxEventTime === null || e.eventTime > maxEventTime) maxEventTime = e.eventTime;
    const watermark = maxEventTime - allowedLateness;
    for (const w of windows.values()) {
      if (!w.sealed && w.end <= watermark) w.sealed = true;
    }

    const start = Math.floor(e.eventTime / windowSize) * windowSize;
    let w = windows.get(start);
    if (w && w.sealed) {
      // Window already sealed: the event can only be recorded as an appendix.
      appendix.push({ ...eventRecordOf(e, 0), reason: 'LATE_AFTER_SEAL' });
      inAppendix[i] = true;
      continue;
    }
    if (!w) {
      w = {
        start,
        end: start + windowSize,
        sealed: false,
        netAmount: 0,
        events: [],
        hash: windowHeadHash(start, start + windowSize),
      };
      windows.set(start, w);
    }

    let contribution = 0;
    if (e.type === 'append') {
      contribution = e.amount ?? 0;
      if (versions.has(e.seq)) {
        errors.push({ seq: e.seq, code: 'DUPLICATE_SEQ', ref: null });
      }
      versions.set(e.seq, { effective: contribution, chain: [e.seq] });
    } else if (e.type === 'correct') {
      const target = versions.get(e.ref);
      if (typeof e.ref !== 'number' || e.ref >= e.seq || !target) {
        // Dangling or forward-pointing ref: record and continue.
        errors.push({ seq: e.seq, code: 'DANGLING', ref: typeof e.ref === 'number' ? e.ref : null });
      } else {
        // New effective version of the target seq; corrects form a version chain.
        contribution = (e.amount ?? 0) - target.effective;
        target.effective = e.amount ?? 0;
        target.chain.push(e.seq);
      }
    } else {
      errors.push({ seq: e.seq, code: 'UNKNOWN_TYPE', ref: null });
    }

    contributions[i] = contribution;
    const rec = eventRecordOf(e, contribution);
    const leaf = eventLeafHash(rec);
    w.hash = foldWindowEvent(w.hash, leaf);
    w.netAmount += contribution;
    w.events.push({ ...rec, hash: leaf });
  }

  for (const w of windows.values()) w.sealed = true;
  const windowList = [...windows.values()].sort((a, b) => a.start - b.start);
  const appendixOut = appendix.map((a) => ({ ...a, hash: appendixLeafHash(a) }));

  const report = {
    version: REPORT_VERSION,
    params: { windowSize, allowedLateness },
    windows: windowList.map((w) => ({
      start: w.start,
      end: w.end,
      sealed: w.sealed,
      eventCount: w.events.length,
      netAmount: w.netAmount,
      hash: w.hash,
      events: w.events,
    })),
    appendix: appendixOut,
    errors,
    root: null,
  };
  report.root = computeRoot(report);

  if (opts.naive) {
    for (let i = 0; i < sorted.length; i += 1) {
      if (inAppendix[i]) continue;
      const recomputed = naiveContribution(sorted, i);
      if (recomputed !== contributions[i]) {
        throw new NaiveMismatchError(
          `naive cross-check failed at seq ${sorted[i].seq}: ` +
            `incremental=${contributions[i]} naive=${recomputed}`,
        );
      }
    }
  }

  return report;
}

// Recompute every hash from the report's own fields. Returns a list of
// human-readable failures with window locations; empty means valid.
export function verifyReport(report) {
  const failures = [];
  if (!report || typeof report !== 'object') return ['report is not an object'];
  const params = report.params ?? {};

  const windows = Array.isArray(report.windows) ? report.windows : [];
  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i];
    const where = `window[${i}] start=${w.start}`;
    if (w.sealed !== true) failures.push(`${where}: window not sealed`);
    if (w.end !== w.start + params.windowSize) {
      failures.push(`${where}: end does not match start+windowSize`);
    }
    let h = windowHeadHash(w.start, w.end);
    let net = 0;
    const evs = Array.isArray(w.events) ? w.events : [];
    for (const ev of evs) {
      const { hash, ...fields } = ev;
      const leaf = eventLeafHash(fields);
      if (leaf !== ev.hash) {
        failures.push(`${where}: event seq=${ev.seq} hash mismatch`);
      }
      net += ev.contribution ?? 0;
      h = foldWindowEvent(h, leaf);
    }
    if (net !== w.netAmount) failures.push(`${where}: netAmount mismatch`);
    if (evs.length !== w.eventCount) failures.push(`${where}: eventCount mismatch`);
    if (h !== w.hash) failures.push(`${where}: window hash mismatch`);
  }

  const appendix = Array.isArray(report.appendix) ? report.appendix : [];
  for (let i = 0; i < appendix.length; i += 1) {
    if (appendixLeafHash(appendix[i]) !== appendix[i].hash) {
      failures.push(`appendix[${i}] seq=${appendix[i].seq}: hash mismatch`);
    }
  }

  const recomputed = computeRoot({
    version: report.version,
    params,
    windows,
    appendix,
    errors: Array.isArray(report.errors) ? report.errors : [],
  });
  if (recomputed !== report.root) {
    failures.push(`root mismatch: expected ${recomputed} got ${report.root}`);
  }
  return failures;
}
