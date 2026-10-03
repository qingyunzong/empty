#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ReconError, publicCandidate } = require('./recon');
const store = require('./store');

function fail(io, code, message) {
  io.stderr(JSON.stringify({ ok: false, error: { code, message } }) + '\n');
  return 1;
}

function run(argv, io) {
  const args = argv.slice(2);
  if (args.length !== 2) {
    return fail(io, 'USAGE', 'usage: node src/cli.js <events.json> <workdir>');
  }
  const [eventsFile, workdir] = args;

  let raw;
  try {
    raw = fs.readFileSync(eventsFile, 'utf8');
  } catch (err) {
    return fail(io, 'EVENTS_FILE_UNREADABLE', `cannot read events file "${eventsFile}": ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return fail(io, 'EVENTS_FILE_INVALID_JSON', `events file is not valid JSON: ${err.message}`);
  }

  const events = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.events)
      ? parsed.events
      : null;
  if (!events) {
    return fail(io, 'EVENTS_FILE_INVALID_SHAPE', 'events file must be a JSON array or an object with an "events" array');
  }

  try {
    fs.mkdirSync(workdir, { recursive: true });
  } catch (err) {
    return fail(io, 'WORKDIR_UNUSABLE', `cannot create workdir "${workdir}": ${err.message}`);
  }
  const logPath = path.join(workdir, store.LOG_FILE);

  let replayed;
  try {
    replayed = store.replayLogFile(logPath);
  } catch (err) {
    if (err instanceof ReconError) return fail(io, err.code, err.message);
    throw err;
  }
  const { engine, records } = replayed;

  const newRecords = [];
  try {
    for (const event of events) {
      const result = engine.applyEvent(event);
      newRecords.push({ event, result });
    }
  } catch (err) {
    if (err instanceof ReconError) return fail(io, err.code, err.message);
    throw err;
  }

  try {
    store.appendRecords(logPath, newRecords, records.length + 1);
  } catch (err) {
    return fail(io, 'LOG_WRITE_FAILED', `cannot append to log "${logPath}": ${err.message}`);
  }

  const certificate = engine.certificate();
  const out = {
    ok: true,
    stateHash: engine.stateHash(),
    certificate,
    matches: certificate.matches,
    candidates: engine.candidates.map(publicCandidate),
    eventsApplied: records.length + newRecords.length,
  };
  io.stdout(JSON.stringify(out, null, 2) + '\n');
  return 0;
}

const stdio = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
};

if (require.main === module) {
  process.exit(run(process.argv, stdio));
}

module.exports = { run, stdio };
