#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Engine, EngineError, canonical } = require('../src/engine');

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function readEvents(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new EngineError(`cannot read events file '${file}': ${err.message}`);
  }
  const events = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (err) {
      throw new EngineError(`line ${i + 1}: invalid JSON: ${err.message}`);
    }
  }
  return events;
}

function sanitize(id) {
  return String(id).replace(/[^A-Za-z0-9_-]/g, '_');
}

function cmdRun(args) {
  const file = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
  if (!file) throw new EngineError('usage: obs run <events.jsonl> [--state DIR]');
  const stateDir = option(args, '--state') || '.obs-state';
  const engine = new Engine();
  for (const ev of readEvents(file)) engine.ingest(ev);
  const { output, checkpoints } = engine.fold();
  if (checkpoints.length > 0) {
    fs.mkdirSync(stateDir, { recursive: true });
    for (const cp of checkpoints) {
      fs.writeFileSync(
        path.join(stateDir, `checkpoint-${sanitize(cp.id)}.json`),
        JSON.stringify(cp, null, 2) + '\n');
    }
    const last = checkpoints[checkpoints.length - 1];
    fs.writeFileSync(path.join(stateDir, 'latest.json'), JSON.stringify(last, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

function cmdRecover(args) {
  const stateDir = option(args, '--state') || '.obs-state';
  const eventsFile = option(args, '--events');
  const cpFile = option(args, '--checkpoint') || path.join(stateDir, 'latest.json');
  let cp;
  try {
    cp = JSON.parse(fs.readFileSync(cpFile, 'utf8'));
  } catch (err) {
    throw new EngineError(`cannot read checkpoint '${cpFile}': ${err.message}`);
  }
  // Replay the checkpointed event prefix and verify its certificate.
  const engine = new Engine();
  for (const ev of cp.events) engine.ingest(ev);
  const verify = engine.fold();
  const verified = verify.output.certificate === cp.certificate;
  let output = verify.output;
  let continuedEvents = 0;
  if (eventsFile) {
    // Continue with the stream events not covered by the checkpoint.
    const consumed = new Map();
    for (const ev of cp.events) {
      const k = canonical(ev);
      consumed.set(k, (consumed.get(k) || 0) + 1);
    }
    const remaining = [];
    for (const ev of readEvents(eventsFile)) {
      const k = canonical(ev);
      const n = consumed.get(k) || 0;
      if (n > 0) consumed.set(k, n - 1);
      else remaining.push(ev);
    }
    for (const ev of remaining) engine.ingest(ev);
    output = engine.fold().output;
    continuedEvents = remaining.length;
  }
  const result = {
    recovered: true,
    checkpoint: cp.id,
    verified,
    continuedEvents,
    certificate: output.certificate,
    output,
  };
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!verified) process.exitCode = 4;
}

function main() {
  const [, , cmd, ...args] = process.argv;
  try {
    if (cmd === 'run') cmdRun(args);
    else if (cmd === 'recover') cmdRecover(args);
    else {
      process.stderr.write('usage: obs <run|recover> ...\n');
      process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof EngineError) {
      process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
      process.exitCode = err.exitCode;
    } else {
      throw err;
    }
  }
}

main();
