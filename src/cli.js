#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { Engine } = require('./engine');
const { OeeError } = require('./model');

const USAGE = 'usage: node src/cli.js oee <events.json> <commands.json> -o <out.json>';

function readJsonFile(filePath, kind) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new OeeError('FILE_ERROR', `cannot read ${kind} file ${filePath}: ${err.message}`, {
      path: filePath,
    });
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new OeeError('JSON_ERROR', `invalid JSON in ${kind} file ${filePath}: ${err.message}`, {
      path: filePath,
    });
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args[0] !== 'oee') {
    throw new OeeError('USAGE', USAGE);
  }
  const positional = [];
  let outPath = null;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-o' || arg === '--output') {
      outPath = args[++i];
    } else if (arg.startsWith('-')) {
      throw new OeeError('USAGE', `unknown option ${arg}\n${USAGE}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2 || !outPath) {
    throw new OeeError('USAGE', USAGE);
  }
  return { eventsPath: positional[0], commandsPath: positional[1], outPath };
}

function execute(argv) {
  const { eventsPath, commandsPath, outPath } = parseArgs(argv);
  const events = readJsonFile(eventsPath, 'events');
  const commandsRaw = readJsonFile(commandsPath, 'commands');

  const engine = new Engine();
  engine.loadEvents(events);

  let commands;
  if (Array.isArray(commandsRaw)) {
    commands = commandsRaw;
  } else if (commandsRaw && typeof commandsRaw === 'object' && Array.isArray(commandsRaw.commands)) {
    commands = commandsRaw.commands;
  } else {
    throw new OeeError('INVALID_COMMANDS', 'commands file must contain a JSON array or { "commands": [...] }');
  }

  const diffs = [];
  commands.forEach((cmd, i) => {
    try {
      const diff = engine.executeCommand(cmd);
      diffs.push({ commandIndex: i, op: cmd && cmd.op, ...diff });
    } catch (err) {
      if (err instanceof OeeError) {
        throw new OeeError(err.code, `command[${i}] (${cmd && cmd.op}): ${err.message}`, {
          commandIndex: i,
          command: cmd,
          cause: err.details,
        });
      }
      throw err;
    }
  });

  const snap = engine.snapshot();
  const out = {
    ok: true,
    version: snap.version,
    intervals: snap.intervals,
    sessions: snap.sessions,
    shifts: snap.shifts,
    diff: diffs,
  };
  try {
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');
  } catch (err) {
    throw new OeeError('FILE_ERROR', `cannot write output file ${outPath}: ${err.message}`, {
      path: outPath,
    });
  }
  return { version: snap.version, output: outPath };
}

function errorPayload(err) {
  if (err instanceof OeeError) {
    const payload = { ok: false, error: { code: err.code, message: err.message } };
    if (err.details !== undefined) payload.error.details = err.details;
    return payload;
  }
  return {
    ok: false,
    error: { code: 'INTERNAL_ERROR', message: err && err.message ? err.message : String(err) },
  };
}

function run(argv, io) {
  try {
    const result = execute(argv);
    io.stdout(JSON.stringify({ ok: true, version: result.version, output: result.output }) + '\n');
    return 0;
  } catch (err) {
    io.stderr(JSON.stringify(errorPayload(err), null, 2) + '\n');
    return 1;
  }
}

if (require.main === module) {
  const code = run(process.argv, {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exitCode = code;
}

module.exports = { run, execute };
