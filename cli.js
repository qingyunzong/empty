#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Scheduler, SchedulerError, E_EMPTY } from './src/scheduler.js';
import { PositionalIndex } from './src/index.js';

const DEFAULT_STATE = '.sched-state.json';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[++i];
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function statePath(args) {
  return args.state || DEFAULT_STATE;
}

function emptyState() {
  return { budget: null, tasks: [], undoStack: [], redoStack: [], notes: [], nextNoteId: 1 };
}

function loadState(args) {
  const p = statePath(args);
  if (!existsSync(p)) {
    throw new SchedulerError(E_EMPTY, `no plan loaded (state file ${p} missing); run "plan <file>" first`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}

function saveState(args, state) {
  writeFileSync(statePath(args), JSON.stringify(state, null, 2) + '\n');
}

function toScheduler(state) {
  const s = new Scheduler({ budget: state.budget ?? Infinity });
  for (const t of state.tasks) s.addTask(t);
  s.undoStack = state.undoStack;
  s.redoStack = state.redoStack;
  return s;
}

function fromScheduler(state, s) {
  state.tasks = [...s.tasks.values()];
  state.undoStack = s.undoStack;
  state.redoStack = s.redoStack;
}

function toIndex(state) {
  const idx = new PositionalIndex();
  for (const n of state.notes) idx.addDocument(n.id, n.text, n.meta);
  return idx;
}

function makeCommands(out) {
  const printResult = (r) => out.push(JSON.stringify({
    change: r.record,
    affected: r.affected,
    conflicts: r.conflicts,
  }));

  return {
    // plan <plan.json>  |  plan --suggest --duration D --resources "R1,R2;R3" --window "S E" [--deadline DL]
    plan(args) {
      if (args.suggest) {
        const state = loadState(args);
        const s = toScheduler(state);
        const [ws, we] = String(args.window || '').split(/\s+/).map(Number);
        const resourceOptions = String(args.resources || '')
          .split(';').filter(Boolean).map((g) => g.split(',').filter(Boolean));
        const best = s.findBestPlacement({
          duration: Number(args.duration),
          resourceOptions,
          windowStart: ws,
          windowEnd: we,
          deadline: args.deadline !== undefined ? Number(args.deadline) : Infinity,
        });
        if (best.conflicts > 0 && !args['allow-conflict']) {
          throw new SchedulerError('E_CONFLICT', `best placement still has ${best.conflicts} conflict(s)`);
        }
        out.push(JSON.stringify(best));
        return;
      }
      const file = args._[0];
      if (!file) throw new SchedulerError(E_EMPTY, 'usage: plan <plan.json>');
      const plan = JSON.parse(readFileSync(file, 'utf8'));
      const state = emptyState();
      state.budget = plan.budget ?? null;
      const s = new Scheduler({ budget: state.budget ?? Infinity });
      for (const t of plan.tasks ?? []) s.addTask(t);
      fromScheduler(state, s);
      saveState(args, state);
      out.push(`loaded ${state.tasks.length} task(s), budget=${state.budget ?? 'inf'}`);
    },

    // change --task T --shift N [--note "换模 后 延迟 ..."]
    change(args) {
      const state = loadState(args);
      const s = toScheduler(state);
      const r = s.applyChange({ taskId: args.task, shift: Number(args.shift ?? 0) });
      if (args.note) {
        const id = state.nextNoteId++;
        state.notes.push({
          id,
          text: String(args.note),
          meta: { taskId: args.task, start: r.record.newStart, end: r.record.newEnd },
        });
      }
      fromScheduler(state, s);
      saveState(args, state);
      printResult(r);
    },

    undo(args) {
      const state = loadState(args);
      const s = toScheduler(state);
      const r = s.undo();
      fromScheduler(state, s);
      saveState(args, state);
      printResult(r);
    },

    redo(args) {
      const state = loadState(args);
      const s = toScheduler(state);
      const r = s.redo();
      fromScheduler(state, s);
      saveState(args, state);
      printResult(r);
    },

    // query --phrase "..." [--window "S E"] | query --near "A B K" | query --delete-note ID
    query(args) {
      const state = loadState(args);
      if (args['delete-note'] !== undefined) {
        const id = Number(args['delete-note']);
        const before = state.notes.length;
        state.notes = state.notes.filter((n) => n.id !== id);
        if (state.notes.length === before) {
          throw new SchedulerError(E_EMPTY, `note ${id} not found`);
        }
        saveState(args, state);
        out.push(`deleted note ${id}`);
        return;
      }
      const idx = toIndex(state);
      let window;
      if (args.window) {
        const [ws, we] = String(args.window).split(/\s+/).map(Number);
        window = { start: ws, end: we };
      }
      let hits;
      if (args.phrase !== undefined) {
        hits = idx.phrase(String(args.phrase), { window });
      } else if (args.near !== undefined) {
        const [a, b, k] = String(args.near).split(/\s+/);
        hits = idx.near(a, b, Number(k), { window });
      } else {
        throw new SchedulerError(E_EMPTY, 'usage: query --phrase "..." | --near "A B K"');
      }
      if (hits.length === 0) throw new SchedulerError(E_EMPTY, 'no matching change notes');
      for (const h of hits) {
        const note = state.notes.find((n) => n.id === h.docId);
        out.push(JSON.stringify({ id: h.docId, ...h, text: note?.text, meta: note?.meta }));
      }
    },
  };
}

// Programmatic entry: returns { code, stdout, stderr } without exiting.
export function runCli(argv) {
  const [cmd, ...rest] = argv;
  const out = [];
  const commands = makeCommands(out);
  const fn = commands[cmd];
  if (!fn) {
    return { code: 2, stdout: '', stderr: `usage: cli.js <${Object.keys(commands).join('|')}> [options]\n` };
  }
  try {
    fn(parseArgs(rest));
    return { code: 0, stdout: out.join('\n') + '\n', stderr: '' };
  } catch (e) {
    if (e instanceof SchedulerError || e.code) {
      return { code: 1, stdout: out.join('\n'), stderr: `${e.code}: ${e.message}\n` };
    }
    throw e;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { code, stdout, stderr } = runCli(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exit(code);
}
