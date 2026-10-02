#!/usr/bin/env node
import fs from 'node:fs';
import { Repo } from './src/repo.js';
import { checkLinearizable } from './src/lincheck.js';

function parseArgs(argv) {
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      opts[argv[i].slice(2)] = argv[++i];
    } else {
      positional.push(argv[i]);
    }
  }
  return { opts, positional };
}

const USAGE = `usage:
  mvrepo commit <batch.json> [--repo dir] [--branch name] [--from branch]
  mvrepo forkinfo [--repo dir]
  mvrepo merge <branchA> <branchB> [--repo dir]
  mvrepo view <name> [--repo dir] [--branch name] [--prefix p]
  mvrepo lincheck <log.json>

error codes: E_ORPHAN E_CONFLICT E_BAD_PARENT E_NONLINEAR E_BAD_BATCH E_LOCKED`;

const { opts, positional } = parseArgs(process.argv.slice(2));
const [cmd, ...rest] = positional;
const repoDir = opts.repo ?? process.env.MVREPO_DIR ?? '.mvrepo';

try {
  switch (cmd) {
    case 'commit': {
      if (!rest[0]) throw Object.assign(new Error('commit needs a batch.json file'), { code: 'E_BAD_BATCH' });
      const batch = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
      if (opts.from !== undefined && batch.from === undefined) batch.from = opts.from;
      const repo = new Repo(repoDir);
      const r = repo.commitBatch(batch, { branch: opts.branch });
      console.log(`branch ${r.branch}`);
      console.log(`batch ${r.batchId}`);
      console.log(`version ${r.versionId}`);
      if (r.duplicate) console.log('duplicate true');
      break;
    }
    case 'forkinfo': {
      const repo = new Repo(repoDir);
      console.log(JSON.stringify(repo.forkinfo(), null, 2));
      break;
    }
    case 'merge': {
      const [a, b] = rest;
      if (!a || !b) throw Object.assign(new Error('merge needs two branch names'), { code: 'E_BAD_PARENT' });
      const repo = new Repo(repoDir);
      const r = repo.mergeBranches(a, b);
      console.log(r.merged ? `merged ${a} ${b} -> ${r.versionId}` : `${r.reason} ${r.versionId}`);
      break;
    }
    case 'view': {
      const name = rest[0];
      if (!name) throw Object.assign(new Error('view needs a name'), { code: 'E_BAD_PARENT' });
      const repo = new Repo(repoDir);
      const def = repo.viewDef(name) ?? {};
      const branch = opts.branch ?? def.branch ?? 'main';
      const prefix = opts.prefix ?? def.prefix ?? '';
      const rows = repo.viewRows(branch, prefix);
      console.log(`view ${name} branch ${branch} version ${repo.heads.get(branch)}`);
      for (const [k, v] of Object.entries(rows)) console.log(`${k} = ${JSON.stringify(v)}`);
      break;
    }
    case 'lincheck': {
      if (!rest[0]) throw Object.assign(new Error('lincheck needs a log.json file'), { code: 'E_BAD_BATCH' });
      const log = JSON.parse(fs.readFileSync(rest[0], 'utf8'));
      const res = checkLinearizable(log);
      if (res.linearizable) {
        console.log('LINEARIZABLE');
        console.log(`order ${res.order.join(' ')}`);
      } else {
        console.error(`${res.code}: ${res.reason}`);
        process.exit(1);
      }
      break;
    }
    default:
      console.error(USAGE);
      process.exit(cmd ? 2 : 0);
  }
} catch (err) {
  const code = err.code ?? 'E_INTERNAL';
  console.error(`${code}: ${err.message}`);
  for (const c of err.details?.conflicts ?? []) {
    console.error(
      `conflict ${c.key}: base=${JSON.stringify(c.base)} a=${JSON.stringify(c.a)} b=${JSON.stringify(c.b)}`
    );
  }
  process.exit(1);
}
