#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const { applyPatch } = require('./src/migrate');
const { verifyProof } = require('./src/verify');
const { MigrateError } = require('./src/model');

const USAGE = `usage:
  settlement-migrate migrate <old.json> <patch.json> --out <new.json> --proof <proof.json>
  settlement-migrate verify <old.json> <new.json> <proof.json>`;

function readJson(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new MigrateError(2, `cannot read ${path}: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new MigrateError(2, `cannot parse ${path}: ${err.message}`);
  }
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function parseFlags(args, known) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!known.includes(name)) throw new MigrateError(2, `unknown flag --${name}`);
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) throw new MigrateError(2, `flag --${name} requires a value`);
      flags[name] = value;
      i += 1;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function cmdMigrate(args, stdout) {
  const { positional, flags } = parseFlags(args, ['out', 'proof']);
  if (positional.length !== 2 || !flags.out || !flags.proof) {
    throw new MigrateError(2, `migrate requires <old.json> <patch.json> --out <new.json> --proof <proof.json>`);
  }
  const oldDoc = readJson(positional[0]);
  const patchDoc = readJson(positional[1]);
  const { instructions, proof } = applyPatch(oldDoc, patchDoc);
  writeJson(flags.out, { instructions });
  writeJson(flags.proof, proof);
  const delta = Object.keys(proof.perAccountDelta);
  stdout(
    `migrated -> ${instructions.length} instructions; ` +
      `${proof.ops.length} op(s) applied; per-account delta: ${delta.length === 0 ? 'none' : delta.join(', ')}`
  );
  stdout(`wrote ${flags.out} and ${flags.proof}`);
  return 0;
}

function cmdVerify(args, stdout, stderr) {
  const { positional } = parseFlags(args, []);
  if (positional.length !== 3) {
    throw new MigrateError(2, `verify requires <old.json> <new.json> <proof.json>`);
  }
  const oldDoc = readJson(positional[0]);
  const newDoc = readJson(positional[1]);
  const proof = readJson(positional[2]);
  const result = verifyProof(oldDoc, newDoc, proof);
  if (!result.ok) {
    stderr(`FAIL ${result.invariant}: ${result.message}`);
    return 1;
  }
  stdout('OK: all invariants hold (perAccountDelta, conservation, forbiddenOps)');
  return 0;
}

function run(argv, io = {}) {
  const stdout = io.stdout || ((line) => console.log(line));
  const stderr = io.stderr || ((line) => console.error(line));
  try {
    const [command, ...rest] = argv;
    if (command === 'migrate') return cmdMigrate(rest, stdout);
    if (command === 'verify') return cmdVerify(rest, stdout, stderr);
    stderr(USAGE);
    return 2;
  } catch (err) {
    if (err instanceof MigrateError) {
      stderr(`error[exit${err.exitCode}]: ${err.message}`);
      return err.exitCode;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}

module.exports = { run };
