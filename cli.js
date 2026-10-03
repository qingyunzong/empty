#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const margin = require('./margin');

function parseArgs(argv) {
  let stateFile = process.env.MARGIN_STATE || 'state.json';
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state') {
      if (i + 1 >= argv.length) return { error: 'invalid-arguments' };
      stateFile = argv[i + 1];
      i += 1;
    } else if (argv[i].startsWith('--state=')) {
      stateFile = argv[i].slice('--state='.length);
    } else {
      rest.push(argv[i]);
    }
  }
  return { stateFile, rest };
}

function loadState(file) {
  if (!fs.existsSync(file)) return margin.createState();
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(file, state) {
  fs.writeFileSync(file, JSON.stringify(state, null, 2) + '\n');
}

function parseAmount(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function run(argv, emit = (line) => process.stdout.write(line + '\n')) {
  const fail = (code) => {
    emit(JSON.stringify({ error: code }));
    return 1;
  };

  const parsed = parseArgs(argv);
  if (parsed.error) return fail(parsed.error);
  const { stateFile, rest } = parsed;
  const command = rest[0];
  const args = rest.slice(1);

  if (command === 'credit' || command === 'freeze') {
    if (args.length !== 3) return fail('invalid-arguments');
    const [id, symbol, rawAmount] = args;
    const amount = parseAmount(rawAmount);
    if (amount === null) return fail('invalid-arguments');
    const state = loadState(stateFile);
    if (!state) return fail('invalid-state');
    const event = command === 'credit'
      ? { id, type: 'credit', symbol, amount }
      : { id, type: 'freeze', freezeId: id, symbol, amount };
    const result = margin.applyEvent(state, event);
    if (!result.ok) return fail(result.error);
    saveState(stateFile, state);
    emit(JSON.stringify(margin.readPosition(state, symbol)));
    return 0;
  }

  if (command === 'release') {
    if (args.length !== 3) return fail('invalid-arguments');
    const [id, freezeId, rawAmount] = args;
    const amount = parseAmount(rawAmount);
    if (amount === null) return fail('invalid-arguments');
    const state = loadState(stateFile);
    if (!state) return fail('invalid-state');
    const result = margin.applyEvent(state, { id, type: 'release', freezeId, amount });
    if (!result.ok) return fail(result.error);
    saveState(stateFile, state);
    const symbol = Object.keys(state.positions).find((s) =>
      state.positions[s].frozen[freezeId] || state.positions[s].tombstones[freezeId]);
    emit(JSON.stringify(margin.readPosition(state, symbol)));
    return 0;
  }

  if (command === 'merge') {
    if (args.length !== 1) return fail('invalid-arguments');
    const state = loadState(stateFile);
    if (!state) return fail('invalid-state');
    const other = loadState(args[0]);
    if (!other) return fail('invalid-state');
    const result = margin.mergeStates(state, other);
    if (!result.ok) return fail(result.error);
    saveState(stateFile, state);
    emit(JSON.stringify(margin.getCertificates(state)));
    return 0;
  }

  if (command === 'position') {
    if (args.length !== 1) return fail('invalid-arguments');
    const state = loadState(stateFile);
    if (!state) return fail('invalid-state');
    emit(JSON.stringify(margin.readPosition(state, args[0])));
    return 0;
  }

  if (command === 'cert') {
    if (args.length > 1) return fail('invalid-arguments');
    const state = loadState(stateFile);
    if (!state) return fail('invalid-state');
    emit(JSON.stringify(args.length === 1
      ? margin.getCertificate(state, args[0])
      : margin.getCertificates(state)));
    return 0;
  }

  return fail('unknown-command');
}

if (require.main === module) {
  const code = run(process.argv.slice(2));
  if (code !== 0) process.exitCode = code;
}

module.exports = { run };
