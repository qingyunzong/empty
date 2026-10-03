#!/usr/bin/env node
import { loadStore, saveStore } from '../src/store.js';
import { Planner, PHRASE, MAX_DISTANCE } from '../src/planner.js';
import { PlannerError, E_LIMIT, E_TIE } from '../src/errors.js';

const USAGE = `usage: planner [--store PATH] <command> [options]
  add     --id ID --desc TEXT --material CODE --equipment CODE --cost N --overdue N
  void    --id ID
  restore --id ID
  select  --k N --budget N [--one]
  explain --id ID
store path: --store, else $PLANNER_STORE, else ./planner-store.json`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (key === 'one') {
        opts.one = true;
      } else {
        if (i + 1 >= argv.length) throw new PlannerError(E_LIMIT, `missing value for --${key}`);
        opts[key] = argv[++i];
      }
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

function toInt(v, name) {
  if (typeof v !== 'string' || !/^-?\d+$/.test(v)) {
    throw new PlannerError(E_LIMIT, `${name} must be an integer, got "${v}"`);
  }
  return Number(v);
}

function printOptima(result) {
  console.log(`status: ${result.status}`);
  for (let i = 0; i < result.optima.length; i++) {
    const o = result.optima[i];
    console.log(
      `optimum ${i + 1}: score=${o.score} cost=${o.cost} remaining=${o.remaining} jobs=[${o.ids.join(', ')}]`
    );
  }
}

function main(argv) {
  const opts = parseArgs(argv);
  const [cmd] = opts._;
  const storePath = opts.store ?? process.env.PLANNER_STORE ?? 'planner-store.json';
  if (!cmd) throw new PlannerError(E_LIMIT, 'missing command\n' + USAGE);

  const store = loadStore(storePath);

  switch (cmd) {
    case 'add': {
      store.add({
        id: opts.id,
        description: opts.desc,
        material: opts.material,
        equipment: opts.equipment,
        cost: toInt(opts.cost, 'cost'),
        overdue: toInt(opts.overdue, 'overdue'),
      });
      saveStore(storePath, store);
      console.log(`added: ${opts.id}`);
      break;
    }
    case 'void': {
      store.void(opts.id ?? '');
      saveStore(storePath, store);
      console.log(`voided: ${opts.id}`);
      break;
    }
    case 'restore': {
      store.restore(opts.id ?? '');
      saveStore(storePath, store);
      console.log(`restored: ${opts.id}`);
      break;
    }
    case 'select': {
      const planner = new Planner(store);
      const result = planner.select({
        k: toInt(opts.k, 'k'),
        budget: toInt(opts.budget, 'budget'),
      });
      if (opts.one && result.optima.length > 1) {
        throw new PlannerError(
          E_TIE,
          `select: ${result.optima.length} tied optima (score=${result.optima[0].score}, remaining=${result.optima[0].remaining}); rerun without --one to list all`
        );
      }
      printOptima(result);
      break;
    }
    case 'explain': {
      const id = opts.id ?? '';
      const job = store.jobs.get(id);
      if (!job) throw new PlannerError(E_LIMIT, `explain: job "${id}" does not exist`);
      const planner = new Planner(store);
      const ev = planner.evaluate(job);
      console.log(`job: ${job.id}`);
      console.log(`state: ${job.voided ? 'voided (excluded from candidates, audit retained)' : 'active'}`);
      console.log(`candidate: ${ev.indexCandidate && !job.voided ? 'yes' : 'no'} (来源: 倒排 inverted-index)`);
      for (const [term, positions] of Object.entries(ev.indexTerms)) {
        console.log(`  term "${term}" @ [${positions.join(', ')}]`);
      }
      console.log(`verify (来源: 扫描 linear-scan): matched=${ev.scan.matched}`);
      console.log(`  phrase "${PHRASE}" hits=${ev.scan.phraseHits.length} positions=[${ev.scan.phraseHits.join(', ')}]`);
      for (const p of ev.scan.pairs) {
        console.log(
          `  pair ${job.material}@${p.materialPos} ${job.equipment}@${p.equipmentPos} distance=${p.distance} (<= ${MAX_DISTANCE})`
        );
      }
      if (ev.scan.pairs.length === 0) console.log('  pair: none within distance limit');
      console.log(`hits: ${ev.hits}`);
      console.log(`overdue: ${job.overdue}`);
      console.log(`score: ${ev.score}`);
      console.log('audit:');
      for (const a of store.audit.filter((a) => a.jobId === id)) {
        console.log(`  #${a.seq} ${a.op} ${a.jobId} ${a.at}`);
      }
      break;
    }
    default:
      throw new PlannerError(E_LIMIT, `unknown command "${cmd}"\n${USAGE}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  if (err instanceof PlannerError) {
    console.error(`${err.code}: ${err.message}`);
    process.exitCode = 1;
  } else {
    throw err;
  }
}
