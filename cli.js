#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { applyOps } = require('./src/migrate');
const { verifyMigration } = require('./src/verify');
const { MigrateError, EXIT } = require('./src/errors');

function readJson(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new MigrateError(EXIT.USAGE, `cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new MigrateError(EXIT.USAGE, `invalid JSON in ${path}: ${err.message}`);
  }
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function parseFlags(args, defaults) {
  const positional = [];
  const flags = { ...defaults };
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--out' || args[i] === '--proof') {
      const value = args[i + 1];
      if (value === undefined) throw new MigrateError(EXIT.USAGE, `${args[i]} requires a value`);
      flags[args[i].slice(2)] = value;
      i += 1;
    } else if (args[i].startsWith('--')) {
      throw new MigrateError(EXIT.USAGE, `unknown flag ${args[i]}`);
    } else {
      positional.push(args[i]);
    }
  }
  return { positional, flags };
}

function cmdMigrate(args) {
  const { positional, flags } = parseFlags(args, { out: 'new.json', proof: 'proof.json' });
  if (positional.length !== 2) {
    throw new MigrateError(EXIT.USAGE, 'usage: migrate <old.json> <patch.json> [--out new.json] [--proof proof.json]');
  }
  const oldSet = readJson(positional[0]);
  const patch = readJson(positional[1]);
  const { instructions, proof } = applyOps(oldSet, patch);
  writeJson(flags.out, instructions);
  writeJson(flags.proof, proof);
  const ops = Array.isArray(patch) ? patch : patch.ops || [];
  process.stdout.write(
    `migrated: ${oldSet.length} -> ${instructions.length} instructions (${ops.length} ops)\n` +
    `wrote ${flags.out} and ${flags.proof}\n`
  );
  return EXIT.OK;
}

function cmdVerify(args) {
  const { positional } = parseFlags(args, {});
  if (positional.length !== 3) {
    throw new MigrateError(EXIT.USAGE, 'usage: verify <old.json> <new.json> <proof.json>');
  }
  const oldSet = readJson(positional[0]);
  const newSet = readJson(positional[1]);
  const proof = readJson(positional[2]);
  const result = verifyMigration(oldSet, newSet, proof);
  if (result.ok) {
    process.stdout.write('OK: all invariants hold (conservation, settledProtection, forbiddenOps)\n');
    return EXIT.OK;
  }
  const f = result.failure;
  const accountInfo = f.account ? ` account=${f.account}` : '';
  process.stderr.write(`FAIL invariant=${f.invariant}${accountInfo}: ${f.message}\n`);
  return f.code;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'migrate') return cmdMigrate(rest);
    if (cmd === 'verify') return cmdVerify(rest);
    process.stderr.write('usage: cli.js migrate <old.json> <patch.json> [--out new.json] [--proof proof.json]\n' +
      '       cli.js verify <old.json> <new.json> <proof.json>\n');
    return EXIT.USAGE;
  } catch (err) {
    if (err instanceof MigrateError) {
      process.stderr.write(`error(exit ${err.code}): ${err.message}\n`);
      return err.code;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { main };
