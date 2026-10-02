'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('./engine');
const { DomainError, isPlainObject } = require('./validate');

function errorPayload(err) {
  const code = err instanceof DomainError ? err.code : 'INTERNAL_ERROR';
  const payload = { error: { code, message: err.message } };
  if (err instanceof DomainError && err.details !== undefined) payload.error.details = err.details;
  return payload;
}

function readJsonFile(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new DomainError('FILE_NOT_FOUND', `${label} file not found: ${filePath}`, { path: filePath });
    }
    throw new DomainError('FILE_READ_ERROR', `cannot read ${label} file ${filePath}: ${err.message}`, { path: filePath });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new DomainError('INVALID_JSON', `invalid JSON in ${label} file ${filePath}: ${err.message}`, { path: filePath });
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length < 3 || args[0] !== 'oee') {
    throw new DomainError('INVALID_ARGS', 'usage: node src/cli.js oee <events.json> <commands.json> -o <out.json>');
  }
  const [, eventsPath, commandsPath, ...rest] = args;
  let outPath = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '-o' && i + 1 < rest.length) {
      outPath = rest[i + 1];
      i += 1;
    } else {
      throw new DomainError('INVALID_ARGS', `unexpected argument: ${rest[i]}`);
    }
  }
  if (!outPath) {
    throw new DomainError('INVALID_ARGS', 'missing required -o <out.json> option');
  }
  return { eventsPath, commandsPath, outPath };
}

function applyCommand(store, cmd, index) {
  if (!isPlainObject(cmd) || typeof cmd.op !== 'string') {
    throw new DomainError('INVALID_COMMAND', `command #${index} must be an object with an "op" field`);
  }
  switch (cmd.op) {
    case 'append':
      return store.append(cmd.event);
    case 'correct':
      if (cmd.id === undefined) throw new DomainError('INVALID_COMMAND', `command #${index} (correct) requires "id"`);
      return store.correct(cmd.id, cmd.event);
    case 'delete':
      if (cmd.id === undefined) throw new DomainError('INVALID_COMMAND', `command #${index} (delete) requires "id"`);
      return store.delete(cmd.id);
    case 'undo':
      return store.undo();
    case 'redo':
      return store.redo();
    default:
      throw new DomainError('INVALID_COMMAND', `command #${index} has unknown op ${JSON.stringify(cmd.op)}`);
  }
}

function run(argv, io) {
  try {
    execute(argv, io);
    return 0;
  } catch (err) {
    io.stderr(JSON.stringify(errorPayload(err)) + '\n');
    return 1;
  }
}

function execute(argv, io) {
  const { eventsPath, commandsPath, outPath } = parseArgs(argv);

  const eventsDoc = readJsonFile(eventsPath, 'events');
  if (!isPlainObject(eventsDoc) || !Array.isArray(eventsDoc.events)) {
    throw new DomainError('INVALID_INPUT', 'events file must be an object: { "shifts": [...], "events": [...] }');
  }
  const shifts = Array.isArray(eventsDoc.shifts) ? eventsDoc.shifts : [];
  const store = new Store(shifts);
  for (const ev of eventsDoc.events) {
    store.append(ev);
  }
  store.undoStack = [];
  store.redoStack = [];

  const commandsDoc = readJsonFile(commandsPath, 'commands');
  const commands = Array.isArray(commandsDoc) ? commandsDoc : commandsDoc && commandsDoc.commands;
  if (!Array.isArray(commands)) {
    throw new DomainError('INVALID_INPUT', 'commands file must be a JSON array of commands');
  }
  const diffs = [];
  commands.forEach((cmd, i) => {
    diffs.push(applyCommand(store, cmd, i));
  });

  const output = {
    version: store.version(),
    sessions: store.sessionList(),
    shifts: store.shiftMetrics(),
    diffs,
  };
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + '\n');
  io.stdout(JSON.stringify({ ok: true, out: outPath, version: output.version }) + '\n');
}

if (require.main === module) {
  process.exitCode = run(process.argv, {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
}

module.exports = { run };
