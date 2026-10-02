#!/usr/bin/env node
'use strict';

const { Engine } = require('../src/engine');
const { LineageError } = require('../src/errors');

function parseArgv(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        opts[key] = argv[i + 1];
        i += 1;
      } else {
        opts[key] = true;
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, opts };
}

function num(v, dflt) {
  return v === undefined ? dflt : Number(v);
}

function list(v) {
  if (v === undefined || v === true || v === '') return [];
  return String(v).split(',').filter(Boolean);
}

function parseQuotas(v) {
  const out = {};
  for (const pair of list(v)) {
    const [k, val] = pair.split('=');
    out[k] = Number(val);
  }
  return out;
}

function print(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

const USAGE = 'usage: lineage <init|submit|invalidate|correct|preempt|schedule|commit|undo|status> [args] [--state dir]\n';

function main(argv) {
  const { pos, opts } = parseArgv(argv);
  const command = pos[0];
  const dir = typeof opts.state === 'string' ? opts.state : '.lineage';

  switch (command) {
    case 'init': {
      const engine = Engine.init(dir, {
        cpus: num(opts.cpus, 4),
        mem: num(opts.mem, 16384),
        quotas: parseQuotas(opts.quota),
      });
      print({ initialized: true, generation: engine.state.generation, stateRoot: engine.root });
      return;
    }
    case 'submit': {
      const engine = Engine.open(dir);
      const node = engine.submit(pos[1], {
        cpu: num(opts.cpu, 1),
        mem: num(opts.mem, 0),
        bytes: num(opts.bytes, 0),
        cost: num(opts.cost, 1),
        owner: opts.owner,
        deps: list(opts.deps),
        fails: num(opts.fails, 0),
        recomputable: !opts['non-recomputable'],
      });
      print({ submitted: node.id, stateRoot: engine.root });
      return;
    }
    case 'invalidate': {
      const engine = Engine.open(dir);
      const invalidated = engine.invalidate(pos[1]);
      print({ invalidated, stateRoot: engine.root });
      return;
    }
    case 'correct': {
      const engine = Engine.open(dir);
      const patch = {};
      if (opts.deps !== undefined) patch.deps = list(opts.deps);
      for (const k of ['cpu', 'mem', 'bytes', 'cost']) {
        if (opts[k] !== undefined) patch[k] = Number(opts[k]);
      }
      if (opts.owner !== undefined) patch.owner = opts.owner;
      const invalidated = engine.correct(pos[1], patch);
      print({ corrected: pos[1], invalidated, stateRoot: engine.root });
      return;
    }
    case 'preempt': {
      const engine = Engine.open(dir);
      print({ ...engine.preempt(pos[1]), stateRoot: engine.root });
      return;
    }
    case 'schedule': {
      const engine = Engine.open(dir);
      const result = engine.schedule({
        preempt: list(opts.preempt),
        agingRate: opts.aging !== undefined ? Number(opts.aging) : undefined,
      });
      print({ schedule: result.events, completed: result.completed, stateRoot: result.stateRoot });
      return;
    }
    case 'commit': {
      const engine = Engine.open(dir);
      print({ committed: true, ...engine.commit() });
      return;
    }
    case 'undo': {
      const engine = Engine.open(dir);
      print({ rolledBack: true, ...engine.undo() });
      return;
    }
    case 'status': {
      const engine = Engine.open(dir);
      print(engine.status());
      return;
    }
    default:
      process.stderr.write(USAGE);
      process.exit(2);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof LineageError) {
    process.stderr.write(`error[${err.code}]: ${err.message}\n`);
    process.exit(7);
  }
  throw err;
}
