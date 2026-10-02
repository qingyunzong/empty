#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const store = require('./lib/store');
const engine = require('./lib/engine');

const { CorruptionError } = store;
const { BusinessError } = engine;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        if (args[key] === undefined) args[key] = next;
        else if (Array.isArray(args[key])) args[key].push(next);
        else args[key] = [args[key], next];
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function persistSidecars(dir, scan, state) {
  const confirmed = scan.confirmed;
  const st = state || engine.computeState(confirmed);
  // The index is a locator: it covers every chunk whose events still decode,
  // so find can reach quarantined/pending chunks and report their status.
  // State (balances/fees) is computed from confirmed chunks only.
  const indexable = scan.chunks.filter((c) => Array.isArray(c.events));
  writeJson(store.indexFile(dir), {
    ...engine.buildIndex(indexable),
    confirmedChunks: confirmed.length,
  });
  writeJson(store.stateFile(dir), {
    confirmedChunks: confirmed.length,
    ...engine.publicState(st),
    txs: st.txs,
  });
  writeJson(store.quarantineFile(dir), {
    quarantined: scan.quarantined.map((c) => c.index),
    pending: scan.pending.map((c) => c.index),
  });
  return st;
}

function requireCleanScan(dir) {
  const scan = store.scanStore(dir);
  if (scan.garbageTail) {
    throw new CorruptionError('non-zero garbage after last chunk; ledger is corrupt');
  }
  if (scan.quarantined.length > 0) {
    throw new CorruptionError('hash chain broken: quarantined chunks present; run audit/rebuild', {
      quarantined: scan.quarantined.map((c) => c.index),
    });
  }
  return scan;
}

function cmdAppend(dir, events, slotSize) {
  if (events.length === 0) throw new BusinessError('append requires at least one --event');
  store.ensureStore(dir, slotSize);
  const scan = requireCleanScan(dir);
  const allEvents = scan.confirmed.flatMap((c) => c.events);
  const state = engine.emptyState();
  for (const ev of allEvents) engine.applyEvent(state, ev);
  for (const ev of events) engine.applyEvent(state, ev); // validates business rules
  allEvents.push(...events);
  const packed = store.packEvents(scan.slotSize, allEvents);
  store.writeStore(dir, scan.slotSize, packed); // also drops any zero tail
  const chunks = packed.map((evs, i) => ({ index: i, events: evs }));
  writeJson(store.indexFile(dir), engine.buildIndex(chunks));
  writeJson(store.stateFile(dir), {
    confirmedChunks: packed.length,
    ...engine.publicState(state),
    txs: state.txs,
  });
  writeJson(store.quarantineFile(dir), { quarantined: [], pending: [] });
  return {
    out: { appended: events.length, chunks: packed.length, events: allEvents.length },
    code: 0,
  };
}

function cmdAudit(dir) {
  const scan = store.scanStore(dir);
  const state = persistSidecars(dir, scan);
  const corrupted = scan.quarantined.length > 0 || scan.garbageTail;
  return {
    out: {
      status: corrupted ? 'corrupted' : 'ok',
      slotSize: scan.slotSize,
      chunks: scan.chunks.map((c) => ({
        index: c.index,
        offset: c.offset,
        endOffset: c.endOffset,
        eventCount: c.eventCount,
        status: c.status,
      })),
      confirmed: scan.confirmed.length,
      quarantined: scan.quarantined.map((c) => c.index),
      pending: scan.pending.map((c) => c.index),
      zeroTail: scan.zeroTailSlots + (scan.partialZeroTail ? 1 : 0),
      garbageTail: scan.garbageTail,
      ...engine.publicState(state),
    },
    code: corrupted ? 2 : 0,
  };
}

function cmdFind(dir, { tx, account }) {
  const index = readJson(store.indexFile(dir), null);
  if (!index) throw new BusinessError('index missing; run rebuild first');
  if (tx) {
    const hits = new Set();
    if (index.txs[tx] !== undefined) hits.add(index.txs[tx]);
    if (index.refs && index.refs[tx] !== undefined) hits.add(index.refs[tx]);
    if (hits.size === 0) throw new BusinessError(`tx ${tx} not found`);
    const events = [];
    const chunks = [...hits].sort((a, b) => a - b);
    for (const ci of chunks) {
      const chunk = store.readChunk(dir, ci); // decodes only the located chunk
      for (const ev of chunk.events) {
        if (ev.tx === tx || ev.refTx === tx) events.push(ev);
      }
    }
    return { out: { tx, chunks, events }, code: 0 };
  }
  if (account) {
    const chunks = (index.accounts[account] || []).slice().sort((a, b) => a - b);
    const events = [];
    for (const ci of chunks) {
      const chunk = store.readChunk(dir, ci);
      for (const ev of chunk.events) if (ev.account === account) events.push(ev);
    }
    return { out: { account, chunks, events }, code: 0 };
  }
  throw new BusinessError('find requires --tx or --account');
}

function cmdCancel(dir, tx) {
  store.ensureStore(dir);
  const scan = requireCleanScan(dir);
  const allEvents = scan.confirmed.flatMap((c) => c.events);
  const state = engine.emptyState();
  for (const ev of allEvents) engine.applyEvent(state, ev);
  const orig = state.txs[tx];
  if (!orig) throw new BusinessError(`tx ${tx} not found`);
  if (orig.type === 'cancel') throw new BusinessError(`tx ${tx} is a cancel event`);
  if (state.cancelled.includes(tx)) throw new BusinessError(`tx ${tx} already cancelled`);
  let cancelTx = `CXL-${tx}`;
  let n = 2;
  while (state.txs[cancelTx]) cancelTx = `CXL-${tx}-${n++}`;
  const ev = {
    type: 'cancel',
    account: orig.account,
    tx: cancelTx,
    refTx: tx,
    amount: orig.amount,
  };
  const res = cmdAppend(dir, [ev]);
  return { out: { cancelled: tx, cancelTx, event: ev, chunks: res.out.chunks }, code: 0 };
}

function cmdQuarantine(dir) {
  const scan = store.scanStore(dir);
  writeJson(store.quarantineFile(dir), {
    quarantined: scan.quarantined.map((c) => c.index),
    pending: scan.pending.map((c) => c.index),
  });
  const corrupted = scan.quarantined.length > 0 || scan.garbageTail;
  return {
    out: {
      status: corrupted ? 'corrupted' : 'ok',
      quarantined: scan.quarantined.map((c) => c.index),
      pending: scan.pending.map((c) => c.index),
      garbageTail: scan.garbageTail,
    },
    code: corrupted ? 2 : 0,
  };
}

function cmdRebuild(dir) {
  const scan = store.scanStore(dir);
  if (scan.garbageTail) {
    throw new CorruptionError('non-zero garbage in tail; refusing to truncate');
  }
  // Zero padding at the tail is an unfinished tail, not corruption: drop it.
  const truncated = scan.zeroTailSlots + (scan.partialZeroTail ? 1 : 0);
  if (truncated > 0) {
    const keepSlots = Math.max(
      1,
      ...scan.chunks.map((c) => c.index + 2) // chunk i lives in slot i+1
    );
    store.truncateTo(dir, keepSlots * scan.slotSize);
  }
  const rescan = store.scanStore(dir);
  persistSidecars(dir, rescan);
  const corrupted = rescan.quarantined.length > 0;
  return {
    out: {
      status: corrupted ? 'corrupted' : 'ok',
      truncated,
      chunks: rescan.chunks.length,
      confirmed: rescan.confirmed.length,
      quarantined: rescan.quarantined.map((c) => c.index),
      pending: rescan.pending.map((c) => c.index),
    },
    code: corrupted ? 2 : 0,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  const dir = args.dir || './ledger';
  let result;
  switch (cmd) {
    case 'append': {
      const raw = Array.isArray(args.event) ? args.event : args.event ? [args.event] : [];
      const events = raw.map((s) => JSON.parse(s));
      const slotSize = args['slot-size'] ? Number(args['slot-size']) : store.DEFAULT_SLOT_SIZE;
      result = cmdAppend(dir, events, slotSize);
      break;
    }
    case 'audit':
      result = cmdAudit(dir);
      break;
    case 'find':
      result = cmdFind(dir, { tx: args.tx, account: args.account });
      break;
    case 'cancel':
      if (!args.tx) throw new BusinessError('cancel requires --tx');
      result = cmdCancel(dir, args.tx);
      break;
    case 'quarantine':
      result = cmdQuarantine(dir);
      break;
    case 'rebuild':
      result = cmdRebuild(dir);
      break;
    default:
      throw new BusinessError(
        'usage: cli.js <append|audit|find|cancel|quarantine|rebuild> --dir <path> [options]'
      );
  }
  process.stdout.write(JSON.stringify(result.out, null, 2) + '\n');
  process.exitCode = result.code;
}

main().catch((err) => {
  const code = err instanceof CorruptionError ? 2 : 1;
  process.stderr.write(
    JSON.stringify({ error: err.message, type: err.name || 'Error' }) + '\n'
  );
  process.exitCode = code;
});
