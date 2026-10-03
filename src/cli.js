#!/usr/bin/env node
// CLI for the evidence-chain audit log.
// Usage: node src/cli.js <dir> <command> [args...]
import { buildState, verifyTarget } from './chain.js';
import { appendEvent, compact, recover, CRASH_POINTS } from './store.js';

export function main(argv, { exitOnDone = false } = {}) {
  const [dir, command, ...args] = argv;
  const out = [];
  const print = (s) => out.push(s);

  const fail = (msg, code = 2) => {
    print(msg);
    if (exitOnDone) process.exit(code);
    return { code, stdout: out.join('\n') };
  };

  if (!dir || !command) {
    return fail(`usage: node src/cli.js <dir> <command> [args]
commands:
  register <sampleId> <volumeUL> <time>
  batch <batchId> <expiresAt> <assayType1,assayType2,...>
  aliquot <aliquotId> <parentId> <volumeUL> <time>
  assay <assayId> <sourceId> <batchId> <assayType> <time> [result]
  qc_fail <targetId> <reason> <time>
  revoke <targetId> <reason> <time>
  attest <assayId> <signer> <time>
  verify <targetId> [--budget N] [--now T] [--record]
  compact [--crash-at ${CRASH_POINTS.join('|')}]
  recover
  events`);
  }

  const num = (s) => {
    const n = Number(s);
    if (!Number.isFinite(n)) throw new Error(`not a number: ${s}`);
    return n;
  };
  const flag = (name) => {
    const i = args.indexOf(name);
    return i === -1 ? null : args.splice(i, 2)[1];
  };

  let event = null;
  switch (command) {
    case 'register':
      event = { type: 'register', sampleId: args[0], volume: num(args[1]), time: num(args[2]) };
      break;
    case 'batch':
      event = { type: 'batch', batchId: args[0], expiresAt: num(args[1]), assays: args[2].split(',') };
      break;
    case 'aliquot':
      event = { type: 'aliquot', aliquotId: args[0], parentId: args[1], volume: num(args[2]), time: num(args[3]) };
      break;
    case 'assay':
      event = { type: 'assay', assayId: args[0], sourceId: args[1], batchId: args[2], assayType: args[3], time: num(args[4]), result: args[5] ?? null };
      break;
    case 'qc_fail':
      event = { type: 'qc_fail', targetId: args[0], reason: args[1], time: num(args[2]) };
      break;
    case 'revoke':
      event = { type: 'revoke', targetId: args[0], reason: args[1], time: num(args[2]) };
      break;
    case 'attest':
      event = { type: 'attest', targetId: args[0], signer: args[1], time: num(args[2]) };
      break;
    default:
      break;
  }

  let code = 0;
  if (event) {
    appendEvent(dir, event);
    print(JSON.stringify({ appended: event }));
  } else if (command === 'verify') {
    const targetId = args.shift();
    const budgetArg = flag('--budget');
    const nowArg = flag('--now');
    const record = args.includes('--record');
    const events = recover(dir);
    const state = buildState(events);
    const maxTime = events.reduce((m, e) => Math.max(m, e.time ?? 0), 0);
    const result = verifyTarget(state, targetId, {
      budget: budgetArg != null ? num(budgetArg) : Infinity,
      now: nowArg != null ? num(nowArg) : maxTime,
    });
    if (record) {
      appendEvent(dir, { type: 'verify', targetId, verdict: result.verdict, time: maxTime });
    }
    print(JSON.stringify(result, null, 2));
    code = result.verdict === 'VALID' ? 0 : 1;
  } else if (command === 'compact') {
    const crashAt = flag('--crash-at');
    try {
      const snapshot = compact(dir, crashAt ? { crashAt } : {});
      print(JSON.stringify({ compacted: snapshot.compactedEvents, nodes: snapshot.nodes.length }));
    } catch (e) {
      print(JSON.stringify({ crashed: e.point ?? e.message }));
      code = 3;
    }
  } else if (command === 'recover') {
    print(JSON.stringify({ recovered: recover(dir).length }));
  } else if (command === 'events') {
    print(JSON.stringify(recover(dir), null, 2));
  } else {
    return fail(`unknown command: ${command}`);
  }

  if (exitOnDone) process.exit(code);
  return { code, stdout: out.join('\n') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { code, stdout } = main(process.argv.slice(2));
  if (stdout) console.log(stdout);
  process.exit(code);
}
