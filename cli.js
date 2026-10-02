#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { buildPlan, diffDirs } = require('./lib/core');
const { applyPlan } = require('./lib/apply');
const { resolveConflicts } = require('./lib/resolve');
const { SyncError } = require('./lib/errors');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else {
      args._.push(t);
    }
  }
  return args;
}

function req(args, name) {
  if (!args[name]) throw new SyncError(64, `缺少参数 --${name}`);
  return args[name];
}

const USAGE = 'usage: node cli.js diff|plan|apply|resolve --a DIRA --b DIRB ' +
  '[--plan FILE] [--journal FILE] [--out FILE] [--strategy keep-both|a|b] [--chunk-size N]';

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  try {
    switch (cmd) {
      case 'diff': {
        const r = diffDirs(req(args, 'a'), req(args, 'b'));
        console.log(JSON.stringify(r, null, 2));
        if (r.errors.some((e) => e.code === 61)) process.exitCode = 61;
        break;
      }
      case 'plan': {
        const plan = buildPlan(req(args, 'a'), req(args, 'b'));
        const out = JSON.stringify(plan, null, 2);
        if (args.out) {
          fs.writeFileSync(args.out, out + '\n');
          console.log(`plan written: ${args.out} ops=${plan.ops.length} stats=${JSON.stringify(plan.stats)}`);
        } else {
          console.log(out);
        }
        break;
      }
      case 'apply': {
        const plan = args.plan
          ? JSON.parse(fs.readFileSync(args.plan, 'utf8'))
          : buildPlan(req(args, 'a'), req(args, 'b'));
        const journalPath = args.journal || (args.plan ? `${args.plan}.journal` : undefined);
        const summary = applyPlan(plan, {
          journalPath,
          chunkSize: args['chunk-size'] ? Number(args['chunk-size']) : undefined,
        });
        console.log(JSON.stringify(summary, null, 2));
        if (summary.conflicts > 0) {
          console.error(`存在 ${summary.conflicts} 个未解决冲突 (${summary.conflictKeys.join(', ')}), 请运行 resolve`);
          process.exitCode = 2;
        }
        break;
      }
      case 'resolve': {
        const r = resolveConflicts(req(args, 'a'), req(args, 'b'), { strategy: args.strategy || 'keep-both' });
        console.log(JSON.stringify({ resolved: r.resolved, certIds: r.certificates.map((c) => c.certId) }, null, 2));
        break;
      }
      default:
        console.error(USAGE);
        process.exitCode = 64;
    }
  } catch (e) {
    if (e instanceof SyncError) {
      console.error(`error code=${e.code}: ${e.message}`);
      process.exitCode = e.code;
    } else {
      console.error(e.stack || String(e));
      process.exitCode = 1;
    }
  }
}

main();
