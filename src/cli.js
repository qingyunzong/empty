'use strict';
// CLI logic with injectable IO so it is testable in-process. Returns an exit
// code; business errors are reported on stderr with exit code 9.

const fs = require('node:fs');
const { Engine } = require('./engine');
const { Store, SimulatedCrash } = require('./store');

class CliError extends Error {}

function parseArgs(argv) {
  const positional = [];
  let state = '.recon-state';
  for (let k = 0; k < argv.length; k += 1) {
    if (argv[k] === '--state') {
      k += 1;
      if (k >= argv.length) throw new CliError('--state requires a directory');
      state = argv[k];
    } else {
      positional.push(argv[k]);
    }
  }
  return { positional, state };
}

function replay(store, engine) {
  let events;
  try {
    events = store.loadEvents();
  } catch (err) {
    throw new CliError(`corrupt event log: ${err.message}`);
  }
  for (const event of events) engine.apply(event);
}

function emit(io, snapshot) {
  const seen = new Set();
  for (const cluster of snapshot.clusters) {
    if (seen.has(cluster.id)) continue; // defensive: never emit a cluster twice
    seen.add(cluster.id);
    io.writeOut(JSON.stringify({ kind: 'cluster', ...cluster }) + '\n');
  }
  for (const suggestion of snapshot.suggestions) {
    io.writeOut(JSON.stringify({ kind: 'suggestion', ...suggestion }) + '\n');
  }
  io.writeOut(JSON.stringify(snapshot.certificate) + '\n');
}

function cmdRun(positional, stateDir, io) {
  const input = positional[0] || '-';
  let raw;
  try {
    raw = input === '-' ? io.readStdin() : fs.readFileSync(input, 'utf8');
  } catch (err) {
    throw new CliError(`cannot read input ${input}: ${err.message}`);
  }
  const store = new Store(stateDir, { fault: io.env.RECON_FAULT });
  const engine = new Engine();
  replay(store, engine);
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  for (let n = 0; n < lines.length; n += 1) {
    let event;
    try {
      event = JSON.parse(lines[n]);
    } catch {
      throw new CliError(`line ${n + 1}: invalid JSON`);
    }
    try {
      engine.apply(event); // validate first; only persist events that apply cleanly
    } catch (err) {
      throw new CliError(`line ${n + 1}: ${err.message}`);
    }
    store.appendEvent(event);
  }
  const snapshot = engine.snapshot();
  store.writeIndex({
    certificate: snapshot.certificate,
    clusterIds: snapshot.certificate.clusterIds,
    eventCount: engine.seq,
  });
  emit(io, snapshot);
  return 0;
}

function cmdVerify(stateDir, io) {
  const store = new Store(stateDir, { fault: io.env.RECON_FAULT });
  const engine = new Engine();
  replay(store, engine);
  const index = store.loadIndex();
  if (!index) throw new CliError('no usable cluster index; run `recon run` first');
  const snapshot = engine.snapshot();
  const ok = snapshot.certificate.digest === index.certificate.digest;
  io.writeOut(
    JSON.stringify({
      kind: 'verify',
      ok,
      eventCount: engine.seq,
      expectedDigest: index.certificate.digest,
      actualDigest: snapshot.certificate.digest,
    }) + '\n'
  );
  if (!ok) throw new CliError('certificate mismatch after recomputation');
  return 0;
}

function runCli(argv, io) {
  try {
    const { positional, state } = parseArgs(argv);
    const command = positional.shift();
    if (command === 'run') return cmdRun(positional, state, io);
    if (command === 'verify') return cmdVerify(state, io);
    throw new CliError('usage: recon run <input.jsonl|-> [--state DIR] | recon verify [--state DIR]');
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err; // a real crash has no stderr/exit path
    if (err instanceof CliError) {
      io.writeErr(`recon: error: ${err.message}\n`);
      return 9;
    }
    throw err;
  }
}

module.exports = { runCli, SimulatedCrash };
