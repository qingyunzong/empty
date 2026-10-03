// CLI implementation, importable for in-process testing.
// Diagnostics go to stderr as JSON. Exit codes: 2 usage, 3 rollback, 6 verify.

import fs from 'node:fs';
import { Workspace } from './workspace.js';
import { syncWorkspaces } from './sync.js';
import { MoldPlanError } from './model.js';

export const EXIT = { OK: 0, USAGE: 2, ROLLBACK: 3, VERIFY: 6 };

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
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function readJSON(maybeFile, stdinText) {
  if (maybeFile && maybeFile !== '-' && fs.existsSync(maybeFile)) {
    return JSON.parse(fs.readFileSync(maybeFile, 'utf8'));
  }
  if (maybeFile === '-' || !maybeFile) {
    return JSON.parse(stdinText);
  }
  return JSON.parse(maybeFile);
}

// argv: command + args (no node/script). io: { stdin, stdout, stderr } writers.
// Returns the exit code; never calls process.exit.
export async function runCLI(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.stderr ?? ((s) => process.stderr.write(s + '\n'));
  const stdinText = io.stdin ?? (() => {
    try {
      return fs.readFileSync(0, 'utf8');
    } catch {
      return '';
    }
  })();
  const outJSON = (obj) => out(JSON.stringify(obj));
  const errJSON = (obj) => err(JSON.stringify(obj));

  const [cmd, ...rest] = argv;
  const args = parseArgs(rest);
  const dir = args.dir ?? '.mold-plan';

  try {
    switch (cmd) {
      case 'plan': {
        const ws = new Workspace(dir, args.terminal ?? 'T1').open();
        try {
          if (args.def) {
            const def = readJSON(args.def, stdinText);
            const changes = [];
            for (const m of def.molds ?? []) changes.push({ type: 'addMold', mold: m });
            for (const s of def.shifts ?? []) changes.push({ type: 'addShift', shift: s });
            for (const j of def.jobs ?? []) changes.push({ type: 'addJob', job: j });
            if (changes.length > 0) ws.applyBatch(changes);
          }
          const locked = args.lock ? String(args.lock).split(',') : [];
          const result = ws.plan({ lockedMolds: locked });
          outJSON({ ok: true, ...result });
          if (!result.feasible) {
            errJSON({ ok: false, reason: 'infeasible', pending: result.pending, certificate: result.certificate });
          }
        } finally {
          ws.close();
        }
        return EXIT.OK;
      }
      case 'apply': {
        const ws = new Workspace(dir, args.terminal ?? 'T1').open();
        try {
          const spec = readJSON(args.changes ?? '-', stdinText);
          const changes = spec.changes ?? spec;
          const locked = spec.lockedMolds ?? (args.lock ? String(args.lock).split(',') : []);
          const rec = ws.applyBatch(changes, { lockedMolds: locked });
          outJSON({ ok: true, batch: rec.id, status: ws.status() });
        } finally {
          ws.close();
        }
        return EXIT.OK;
      }
      case 'rollback': {
        const ws = new Workspace(dir, args.terminal ?? 'T1').open();
        try {
          const result = ws.rollback();
          outJSON({ ok: true, ...result });
          return EXIT.OK;
        } catch (e) {
          if (e instanceof MoldPlanError && e.code === 'ROLLBACK') {
            errJSON({ ok: false, error: { code: e.code, message: e.message, details: e.details } });
            return EXIT.ROLLBACK;
          }
          throw e;
        } finally {
          ws.close();
        }
      }
      case 'sync': {
        const peer = args.peer;
        if (!peer) {
          errJSON({ ok: false, error: { code: 'USAGE', message: 'sync requires --peer <dir>' } });
          return EXIT.USAGE;
        }
        const wsA = new Workspace(dir, args.terminal ?? 'T1').open();
        const wsB = new Workspace(peer, args.peerTerminal ?? 'T2').open();
        try {
          const result = syncWorkspaces(wsA, wsB);
          outJSON({ ok: true, ...result });
          if (result.pendingA.length > 0 || result.pendingB.length > 0) {
            errJSON({ ok: false, reason: 'pending', pendingA: result.pendingA, pendingB: result.pendingB });
          }
        } finally {
          wsA.close();
          wsB.close();
        }
        return EXIT.OK;
      }
      case 'verify': {
        const ws = new Workspace(dir, args.terminal ?? 'T1').open();
        try {
          const result = ws.verify();
          outJSON({ ok: result.ok, ...result });
          if (!result.ok) {
            errJSON({ ok: false, reason: 'verify-failed', problems: result.problems });
            return EXIT.VERIFY;
          }
        } finally {
          ws.close();
        }
        return EXIT.OK;
      }
      case 'status': {
        const ws = new Workspace(dir, args.terminal ?? 'T1').open();
        try {
          outJSON({ ok: true, ...ws.status() });
        } finally {
          ws.close();
        }
        return EXIT.OK;
      }
      default:
        errJSON({
          ok: false,
          error: {
            code: 'USAGE',
            message: `unknown command: ${cmd ?? '(none)'}`,
            commands: ['plan', 'apply', 'rollback', 'sync', 'verify'],
          },
        });
        return EXIT.USAGE;
    }
  } catch (e) {
    if (e instanceof MoldPlanError) {
      errJSON({ ok: false, error: { code: e.code, message: e.message, details: e.details } });
      return e.code === 'ROLLBACK' ? EXIT.ROLLBACK : EXIT.USAGE;
    }
    errJSON({ ok: false, error: { code: 'INTERNAL', message: String(e?.stack ?? e) } });
    return 1;
  }
}
