import fs from 'node:fs';
import path from 'node:path';
import { Repo } from './store.js';
import { commit } from './commit.js';
import { mergeVersions } from './merge.js';
import { forkinfo } from './forkinfo.js';
import { lincheck } from './lincheck.js';
import { MvError, err } from './errors.js';

const USAGE = `mvlin - version-graph materialized views

usage: mvlin [--repo DIR] <command> [args]

commands:
  commit <batch.json>     commit an observation batch (prints version + conflicts)
  forkinfo [view]         show heads, forks, and per-branch replay sets
  merge <a> <b>           three-way merge two versions of one view
  view <name> [version]   print materialized state at head(s) or a version
  lincheck <log>          check a real-time log for linearizability

repo dir: --repo flag, MVREPO env, else ./.mvrepo
error codes: E_ORPHAN E_CONFLICT E_BAD_PARENT E_NONLINEAR E_INVALID E_LOCK`;

function parseArgs(argv) {
  const args = [...argv];
  let repo = process.env.MVREPO ?? path.join(process.cwd(), '.mvrepo');
  while (args.length && args[0].startsWith('--')) {
    const flag = args.shift();
    if (flag === '--repo') repo = args.shift();
    else if (flag === '--help') return { help: true };
    else throw err('E_INVALID', `unknown flag ${flag}`);
  }
  return { repo, cmd: args.shift(), args };
}

function readJsonArg(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    // JSONL fallback
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  }
}

const out = (x) => process.stdout.write(JSON.stringify(x, null, 2) + '\n');

export function run(argv) {
  const { repo: dir, cmd, args, help } = parseArgs(argv);
  if (help || !cmd) {
    process.stdout.write(USAGE + '\n');
    return help ? 0 : 1;
  }
  const repo = new Repo(dir); // open implies crash recovery

  switch (cmd) {
    case 'commit': {
      const [file] = args;
      if (!file) throw err('E_INVALID', 'commit needs a batch.json');
      out(commit(repo, readJsonArg(file)));
      return 0;
    }
    case 'forkinfo': {
      const views = args[0] ? [args[0]] : repo.listViews();
      out(views.length === 1 ? forkinfo(repo, views[0]) : views.map((v) => forkinfo(repo, v)));
      return 0;
    }
    case 'merge': {
      const [ra, rb] = args;
      if (!ra || !rb) throw err('E_INVALID', 'merge needs two version ids');
      const view = args[2] ?? findCommonView(repo, ra, rb);
      const a = repo.resolveVersion(view, ra);
      const b = repo.resolveVersion(view, rb);
      const { version, bases, heads } = mergeVersions(repo, view, a, b);
      out({ version: version.id, view, parents: version.parents, bases, adds: version.adds, dels: version.dels, heads });
      return 0;
    }
    case 'view': {
      const [name, prefix] = args;
      if (!name) throw err('E_INVALID', 'view needs a name');
      if (!repo.listViews().includes(name)) throw err('E_INVALID', `unknown view ${name}`);
      if (prefix) {
        out(repo.getVersion(name, repo.resolveVersion(name, prefix)));
        return 0;
      }
      const heads = repo.getHeads(name);
      out({
        view: name,
        heads,
        state: heads.length === 1 ? repo.getVersion(name, heads[0]).state : undefined,
        headStates: heads.length === 1 ? undefined : Object.fromEntries(heads.map((h) => [h, repo.getVersion(name, h).state])),
      });
      return 0;
    }
    case 'lincheck': {
      const [file] = args;
      if (!file) throw err('E_INVALID', 'lincheck needs a log file');
      out(lincheck(repo, readJsonArg(file)));
      return 0;
    }
    default:
      throw err('E_INVALID', `unknown command ${cmd}`);
  }
}

function findCommonView(repo, ra, rb) {
  const views = repo.listViews().filter((v) => {
    try {
      repo.resolveVersion(v, ra);
      repo.resolveVersion(v, rb);
      return true;
    } catch {
      return false;
    }
  });
  if (views.length === 1) return views[0];
  throw err('E_BAD_PARENT', `cannot infer a single view for ${ra} and ${rb}`, { candidates: views });
}

export function main() {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    if (e instanceof MvError) {
      process.stderr.write(`${e.code}: ${e.message}\n`);
      if (e.details !== undefined) process.stderr.write(JSON.stringify(e.details, null, 2) + '\n');
      process.exitCode = 1;
    } else {
      throw e;
    }
  }
}
