'use strict';

const fs = require('node:fs');
const { mergeOrders } = require('./src/merge');
const { RepoError, InvalidPatchError } = require('./src/errors');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      throw new InvalidPatchError('unexpected argument: ' + token);
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new InvalidPatchError('missing value for --' + key);
    }
    args[key] = value;
    i += 1;
  }
  return args;
}

function readJsonFile(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new InvalidPatchError('cannot read file ' + path + ': ' + err.message);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new InvalidPatchError('invalid JSON in ' + path + ': ' + err.message);
  }
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'merge-orders') {
    throw new InvalidPatchError('unknown command: ' + String(command) + ' (expected "merge-orders")');
  }
  const args = parseArgs(rest);
  for (const required of ['base', 'local', 'remote', 'out']) {
    if (!args[required]) throw new InvalidPatchError('missing required option --' + required);
  }

  const base = readJsonFile(args.base);
  const local = readJsonFile(args.local);
  const remote = readJsonFile(args.remote);

  const merged = mergeOrders(base, local, remote);
  fs.writeFileSync(args.out, JSON.stringify(merged, null, 2) + '\n');
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof RepoError) {
      const payload = { error: err.message };
      if (err.conflicts) payload.conflicts = err.conflicts;
      process.stderr.write(JSON.stringify(payload, null, 2) + '\n');
      process.exitCode = err.exitCode;
    } else {
      process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
      process.exitCode = 2;
    }
  }
}

module.exports = { main };
