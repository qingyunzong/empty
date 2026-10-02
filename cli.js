#!/usr/bin/env node
import fs from 'node:fs';
import { Lab, LabError } from './src/lab.js';
import { Journal } from './src/store.js';

const USAGE = `Usage:
  node cli.js [--dir DIR] [--state FILE] <command> '<json-args>'
  node cli.js [--dir DIR] [--state FILE] --script <ops.jsonl>
  node cli.js [--dir DIR] [--state FILE] audit --file <cert.json>

Commands: add_artifact | link | unlink | measure | reserve | release | certify | audit
Only measure persists (append/fsync/rename journal under --dir, default ./data).
--state loads a read-only snapshot: {"artifacts":[...],"links":[{"std","target"}]}.
`;

function parseArgs(argv) {
  const opts = { dir: './data', state: null, script: null, file: null, cmd: null, args: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') opts.dir = argv[++i];
    else if (a === '--state') opts.state = argv[++i];
    else if (a === '--script') opts.script = argv[++i];
    else if (a === '--file') opts.file = argv[++i];
    else if (!opts.cmd) opts.cmd = a;
    else if (opts.args === null) opts.args = a;
    else throw new Error('unexpected argument: ' + a);
  }
  return opts;
}

function makeLab(opts) {
  const lab = new Lab({ store: new Journal(opts.dir) });
  if (opts.state) {
    const snap = JSON.parse(fs.readFileSync(opts.state, 'utf8'));
    for (const a of snap.artifacts ?? []) lab.addArtifact(a);
    for (const l of snap.links ?? []) lab.link(l.std, l.target);
  }
  return lab;
}

function runOne(lab, cmd, args, file) {
  switch (cmd) {
    case 'add_artifact': return lab.addArtifact(args);
    case 'link': return lab.link(args.std, args.target);
    case 'unlink': return lab.unlink(args.std, args.target);
    case 'measure': return lab.measure(args);
    case 'reserve': return lab.reserve(args.std, args.point);
    case 'release': return lab.release(args.lease);
    case 'certify': return lab.certify(args.point, args.budget !== undefined ? { budget: args.budget } : {});
    case 'audit': {
      const cert = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : args;
      return lab.audit(cert);
    }
    default: throw new Error('unknown command: ' + cmd);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.cmd && !opts.script) {
    process.stderr.write(USAGE);
    process.exit(2);
  }
  const lab = makeLab(opts);
  const emit = (r) => process.stdout.write(JSON.stringify(r) + '\n');
  try {
    if (opts.script) {
      const lines = fs.readFileSync(opts.script, 'utf8').split('\n').filter((l) => l.trim());
      for (const line of lines) {
        const op = JSON.parse(line);
        try {
          emit({ cmd: op.cmd, ok: true, result: runOne(lab, op.cmd, op.args ?? null, null) });
        } catch (e) {
          if (e instanceof LabError) emit({ cmd: op.cmd, ok: false, error: e.code, details: e.details });
          else throw e;
        }
      }
    } else {
      const args = opts.args ? JSON.parse(opts.args) : null;
      emit(runOne(lab, opts.cmd, args, opts.file));
    }
  } catch (e) {
    if (e instanceof LabError) {
      emit({ error: e.code, details: e.details });
      process.exit(1);
    }
    throw e;
  }
}

main();
