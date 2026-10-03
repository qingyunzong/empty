#!/usr/bin/env node
'use strict';

const {
  DomainError,
  EXIT8_CODES,
  openCase,
  correctRisk,
  openAppeal,
  closeAppeal,
  closeCase,
  planAssignments,
} = require('../src/engine');
const store = require('../src/store');

function coerce(v) {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

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
        args[key] = coerce(next);
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

class UsageError extends Error {}

function req(args, key) {
  if (args[key] === undefined || args[key] === true) {
    throw new UsageError(`missing required flag --${key}`);
  }
  return args[key];
}

const USAGE = `usage: audit --state <dir> <command> [flags]

commands:
  open    --case ID --dept D --risk N --deadline T --skill S --duration N --time T [--source S]
  assign  --time T [--source S]                prints the assignment certificate (JSON)
  correct --case ID --risk N --time T [--source S]
  appeal  --case ID [--level N] --time T [--source S]
  close   case   --case ID [--result R] [--level N] --time T
  close   appeal --case ID --time T            resolves by hierarchy (level decides revoke/confirm)
  snapshot [--time T]                          persists state + certificate hash
  verify                                       replays the log from genesis and compares hashes

state dir files: reviewers.json (required), config.json (optional),
events.jsonl + snapshot.json (managed). Domain errors SKILL_MISMATCH,
DEADLINE_PAST and DUPLICATE_APPEAL exit with code 8.`;

function run(argv) {
  const args = parseArgs(argv);
  const dir = args.state || './audit-state';
  const [cmd, sub] = args._;
  if (!cmd || cmd === 'help' || args.help) {
    return { code: cmd || args.help ? 0 : 2, stdout: USAGE + '\n', stderr: '' };
  }

  const source = typeof args.source === 'string' ? args.source : 'cli';
  const ctx = store.recover(dir);
  const { state, reviewers, config, events } = ctx;

  let event = null;
  let out = null;

  switch (cmd) {
    case 'open':
      event = openCase(state, reviewers, {
        caseId: String(req(args, 'case')),
        dept: String(req(args, 'dept')),
        risk: Number(req(args, 'risk')),
        deadline: Number(req(args, 'deadline')),
        skill: String(req(args, 'skill')),
        duration: Number(req(args, 'duration')),
        time: Number(req(args, 'time')),
        source,
      });
      break;
    case 'assign': {
      const { event: ev, certificate } = planAssignments(state, reviewers, config, {
        time: Number(req(args, 'time')),
        source,
      });
      event = ev;
      out = certificate;
      break;
    }
    case 'correct':
      event = correctRisk(state, {
        caseId: String(req(args, 'case')),
        risk: Number(req(args, 'risk')),
        time: Number(req(args, 'time')),
        source,
      });
      break;
    case 'appeal':
      event = openAppeal(state, {
        caseId: String(req(args, 'case')),
        level: args.level === undefined ? 1 : Number(args.level),
        time: Number(req(args, 'time')),
        source,
      });
      break;
    case 'close':
      if (sub === 'case') {
        event = closeCase(state, {
          caseId: String(req(args, 'case')),
          result: args.result === undefined ? 'reviewed' : String(args.result),
          level: args.level === undefined ? 1 : Number(args.level),
          time: Number(req(args, 'time')),
          source,
        });
      } else if (sub === 'appeal') {
        event = closeAppeal(state, {
          caseId: String(req(args, 'case')),
          time: Number(req(args, 'time')),
          source,
        });
      } else {
        throw new UsageError('close requires a subtarget: "case" or "appeal"');
      }
      break;
    case 'snapshot': {
      const snap = store.writeSnapshot(
        dir,
        state,
        events.length,
        args.time === undefined ? null : Number(args.time)
      );
      out = {
        ok: true,
        snapshot: store.layout(dir).snap,
        eventCount: snap.eventCount,
        certHash: snap.certHash,
      };
      break;
    }
    case 'verify': {
      const recomputed = store.recompute(dir);
      out = {
        ok: recomputed.certHash === state.certHash,
        recoveredHash: state.certHash,
        recomputedHash: recomputed.certHash,
        match: recomputed.certHash === state.certHash,
        eventCount: recomputed.eventCount,
      };
      break;
    }
    default:
      throw new UsageError(`unknown command: ${cmd}`);
  }

  if (event) {
    store.appendEvent(dir, event);
    if (!out) out = { ok: true, event };
  }
  return { code: 0, stdout: JSON.stringify(out, null, 2) + '\n', stderr: '' };
}

function main(argv = process.argv.slice(2)) {
  let result;
  try {
    result = run(argv);
  } catch (err) {
    let code = 1;
    let payload;
    if (err instanceof UsageError) {
      code = 2;
      payload = { ok: false, code: 'USAGE', message: err.message };
    } else if (err instanceof DomainError) {
      code = EXIT8_CODES.has(err.code) ? 8 : 1;
      payload = { ok: false, code: err.code, message: err.message };
    } else {
      payload = { ok: false, code: 'INTERNAL', message: err.message };
    }
    result = { code, stdout: '', stderr: JSON.stringify(payload) + '\n' };
  }
  return result;
}

if (require.main === module) {
  const result = main();
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exit(result.code);
}

module.exports = { run: main, parseArgs, USAGE };
