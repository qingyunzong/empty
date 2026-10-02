'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  NettingError,
  hashInstruction,
  createState,
  addInstruction,
  cancelInstruction,
  mergeState,
  computeNets,
  settle,
} = require('./src/netting');

const DEFAULT_STATE_FILE = 'netting-state.json';

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next === undefined || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        index += 1;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) {
    return createState();
  }
  const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  return {
    instructions: Array.isArray(parsed.instructions) ? parsed.instructions : [],
    cancels: Array.isArray(parsed.cancels) ? parsed.cancels : [],
  };
}

function saveState(statePath, state) {
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function requireOption(args, name) {
  if (args[name] === undefined || args[name] === true) {
    throw new NettingError('invalid-input', `missing required option --${name}`);
  }
  return args[name];
}

function cmdInstruct(state, args) {
  const amount = Number(requireOption(args, 'amount'));
  const { instruction, added } = addInstruction(state, {
    id: requireOption(args, 'id'),
    payer: requireOption(args, 'payer'),
    payee: requireOption(args, 'payee'),
    amount,
  });
  return { output: { ...instruction, hash: hashInstruction(instruction), added } };
}

function cmdCancel(state, args) {
  const id = requireOption(args, 'id');
  const observedHash = args.hash === true || args.hash === undefined ? undefined : args.hash;
  const { tombstone, applied } = cancelInstruction(state, id, observedHash);
  return { output: { cancelled: tombstone.id, tombstone, applied } };
}

function cmdMerge(state, args) {
  const file = args._[0];
  if (!file) {
    throw new NettingError('invalid-input', 'merge requires a file argument');
  }
  const other = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  const { tombstones } = mergeState(state, other);
  return { output: { merged: true, tombstones } };
}

function cmdNet(state) {
  return { output: { nets: computeNets(state) }, persist: false };
}

function cmdSettle(state, args) {
  let budgets = {};
  if (args.budgets !== undefined && args.budgets !== true) {
    budgets = JSON.parse(args.budgets);
  }
  const certificate = settle(state, budgets);
  return { output: certificate, persist: false, blocked: !certificate.settled };
}

function run(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  const statePath = typeof args.state === 'string' ? args.state : DEFAULT_STATE_FILE;
  const result = { code: 0, stdout: '', stderr: '' };
  const fail = (code) => {
    result.stderr = `${JSON.stringify({ error: code })}\n`;
    result.code = 1;
  };

  const handlers = {
    instruct: cmdInstruct,
    cancel: cmdCancel,
    merge: cmdMerge,
    net: cmdNet,
    settle: cmdSettle,
  };

  try {
    const handler = handlers[command];
    if (!handler) {
      throw new NettingError(
        'invalid-input',
        `unknown command: ${command || '(none)'}. Expected instruct|cancel|merge|net|settle`,
      );
    }
    const state = loadState(statePath);
    const handled = handler(state, args);
    result.stdout = `${JSON.stringify(handled.output, null, 2)}\n`;
    if (handled.persist !== false) {
      saveState(statePath, state);
    }
    if (handled.blocked) {
      fail('budget-exceeded');
    }
  } catch (error) {
    if (error instanceof NettingError) {
      fail(error.code);
    } else {
      fail('invalid-input');
    }
  }
  return result;
}

if (require.main === module) {
  const result = run(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

module.exports = { run, parseArgs };
