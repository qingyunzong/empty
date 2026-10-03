'use strict';
const fs = require('node:fs');
const { Engine } = require('./engine');
const { loadEngine } = require('./store');

// Returns { code, stdout, stderr } instead of touching process directly,
// so the CLI is testable in-process. readStdin is only called when no
// input file argument is given.
function runCli(argv, readStdin) {
  let stdout = '';
  let stderr = '';
  const out = (obj) => { stdout += JSON.stringify(obj) + '\n'; };

  let dataDir = null;
  let inputFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--data') {
      dataDir = argv[++i];
      if (!dataDir) {
        stderr += JSON.stringify({ error: '--data requires a directory' }) + '\n';
        return { code: 7, stdout, stderr };
      }
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      stdout += 'usage: vdsettle [--data DIR] [input.jsonl]  (JSONL commands on stdin if no file)\n';
      return { code: 0, stdout, stderr };
    } else {
      inputFile = argv[i];
    }
  }

  const fail = (msg) => {
    stderr += JSON.stringify({ error: msg }) + '\n';
    return { code: 7, stdout, stderr };
  };

  let engine;
  let store = null;
  let startSeq = 0;
  try {
    if (dataDir) {
      const loaded = loadEngine(dataDir);
      engine = loaded.engine;
      store = loaded.store;
      startSeq = engine.journal.length;
      out({ type: 'loaded', events: startSeq, indexRebuilt: loaded.rebuilt });
    } else {
      engine = new Engine();
    }
  } catch (e) {
    return fail(`cannot load data dir: ${e.message}`);
  }

  let raw;
  try {
    raw = inputFile ? fs.readFileSync(inputFile, 'utf8') : readStdin();
  } catch (e) {
    return fail(`cannot read input: ${e.message}`);
  }

  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let cmd;
    try {
      cmd = JSON.parse(s);
    } catch {
      return fail(`invalid JSON line: ${s.slice(0, 80)}`);
    }
    if (!cmd || typeof cmd.op !== 'string') return fail('command missing "op"');
    const { op, ...payload } = cmd;
    try {
      switch (op) {
        case 'calendar':
        case 'trade':
        case 'cancel':
        case 'delay':
        case 'reprice':
        case 'liquidity': {
          const res = engine.apply(op, payload);
          out({ ok: true, op, ...res });
          break;
        }
        case 'deliverables':
          out({ type: 'deliverables', items: engine.deliverables() });
          break;
        case 'exposures':
          out({ type: 'exposures', items: engine.exposureList() });
          break;
        case 'queues':
          out({ type: 'queues', items: engine.queueSnapshot() });
          break;
        case 'proof': {
          const pr = engine.proof();
          out({ type: 'proof', ...pr, replay: pr.ok ? 'PROOF_OK' : 'PROOF_MISMATCH' });
          break;
        }
        default:
          return fail(`unknown op: ${op}`);
      }
    } catch (e) {
      return fail(e.message);
    }
  }

  if (store) {
    try {
      for (let i = startSeq; i < engine.journal.length; i++) store.append(engine.journal[i]);
      store.saveIndex(engine);
    } catch (e) {
      return fail(`cannot persist: ${e.message}`);
    }
  }
  return { code: 0, stdout, stderr };
}

module.exports = { runCli };
