#!/usr/bin/env node
'use strict';

const { parseArgs } = require('node:util');
const path = require('node:path');
const fs = require('node:fs');
const lib = require('./lib');

function crashFromEnv() {
  const after = process.env.DOSE_CRASH_AFTER;
  if (!after) return null;
  return { after, seq: Number(process.env.DOSE_CRASH_SEQ) };
}

function fail(message, code) {
  fs.writeSync(2, `error: ${message}\n`);
  process.exit(code);
}

function parse(argv, options) {
  try {
    return parseArgs({ args: argv, options, strict: true }).values;
  } catch (err) {
    fail(err.message, 2);
  }
  return null;
}

const str = { type: 'string' };

function main() {
  const [command, ...rest] = process.argv.slice(2);
  let result;
  switch (command) {
    case 'exec': {
      const v = parse(rest, { plan: str, pumps: str, journal: str, out: str });
      if (!v.plan || !v.journal || !v.out) {
        fail('exec requires --plan <file> --journal <dir> --out <dir>', 2);
      }
      let pumps = v.pumps;
      if (!pumps) {
        const sibling = path.join(path.dirname(v.plan), 'pumps.json');
        if (!fs.existsSync(sibling)) fail('missing --pumps <file>', 2);
        pumps = sibling;
      }
      result = lib.execPlan({
        planPath: v.plan,
        pumpsPath: pumps,
        journalDir: v.journal,
        outDir: v.out,
        crash: crashFromEnv(),
      });
      break;
    }
    case 'recover': {
      const v = parse(rest, { journal: str });
      if (!v.journal) fail('recover requires --journal <dir>', 2);
      result = lib.recover({ journalDir: v.journal, crash: crashFromEnv() });
      break;
    }
    case 'modify-plan': {
      const v = parse(rest, { journal: str, plan: str });
      if (!v.journal || !v.plan) fail('modify-plan requires --journal <dir> --plan <file>', 2);
      result = lib.modifyPlan({ journalDir: v.journal, newPlanPath: v.plan });
      break;
    }
    case 'compensate': {
      const v = parse(rest, { journal: str, pump: str, slot: str, dose: str });
      if (!v.journal || !v.pump || v.slot === undefined) {
        fail('compensate requires --journal <dir> --pump <id> --slot <n> [--dose <negative>]', 2);
      }
      result = lib.compensate({
        journalDir: v.journal,
        pumpId: v.pump,
        slot: Number(v.slot),
        dose: v.dose === undefined ? null : Number(v.dose),
      });
      break;
    }
    default:
      fail(
        'usage: node cli.js <exec|recover|modify-plan|compensate> [options]',
        2,
      );
  }
  console.log(JSON.stringify(result, null, 2));
}

try {
  main();
} catch (err) {
  if (err instanceof lib.PlanError) fail(err.message, 2);
  fail(err.message, 1);
}
