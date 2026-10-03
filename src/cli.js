'use strict';
const fs = require('node:fs');
const { DomainError, UsageError, normalizeScenario } = require('./model');
const { canon, sha256 } = require('./canon');
const engine = require('./engine');
const store = require('./store');

function parseArgs(argv) {
  const args = [];
  let state = '.calsched';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--state') {
      state = argv[++i];
    } else if (argv[i].startsWith('--state=')) {
      state = argv[i].slice('--state='.length);
    } else {
      args.push(argv[i]);
    }
  }
  return { args, state };
}

function readInput(file) {
  if (file === '-') return JSON.parse(fs.readFileSync(0, 'utf8'));
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function cmdIngest(args, stateDir) {
  if (args.length !== 1) throw new UsageError('usage: calsched ingest <scenario.json> [--state dir]');
  const scenario = readInput(args[0]);
  const model = normalizeScenario(scenario);
  fs.mkdirSync(stateDir, { recursive: true });
  const p = store.paths(stateDir);
  fs.writeFileSync(p.scenario, JSON.stringify(scenario, null, 2) + '\n');
  fs.writeFileSync(p.events, '');
  for (const f of [p.plan, p.state]) if (fs.existsSync(f)) fs.unlinkSync(f);
  let windows = 0;
  for (const st of model.stations.values()) windows += st.windows.length;
  return {
    ingested: model.name,
    stations: model.stations.size,
    windows,
    contracts: model.contracts.length,
    scenarioHash: sha256(canon(scenario)),
  };
}

function cmdPlan(args, stateDir) {
  if (args.length !== 0) throw new UsageError('usage: calsched plan [--state dir]');
  const scenario = store.loadScenario(stateDir);
  const events = store.readEvents(stateDir);
  const result = engine.fold(scenario, events);
  store.writeOutputs(stateDir, scenario, events, result);
  return result.plan;
}

function runEvent(stateDir, event) {
  const scenario = store.loadScenario(stateDir);
  const events = store.readEvents(stateDir);
  // Fold first; the event log is only appended once the event is known valid.
  const result = engine.fold(scenario, events.concat([event]));
  store.appendEvent(stateDir, event);
  store.writeOutputs(stateDir, scenario, events.concat([event]), result);
  return result;
}

function cmdCorrect(args, stateDir) {
  if (args.length !== 1) throw new UsageError('usage: calsched correct <correction.json> [--state dir]');
  const correction = readInput(args[0]);
  const result = runEvent(stateDir, { type: 'correct', correction });
  const step = result.steps[result.steps.length - 1];
  const unchanged = [...result.model.stations.keys()].filter((id) => !step.affected.includes(id));
  return {
    event: 'correct',
    affected: step.affected,
    replanned: step.replanned,
    unchanged: unchanged.sort(),
    plan: result.plan,
  };
}

function cmdFail(args, stateDir) {
  if (args.length !== 1) throw new UsageError('usage: calsched fail <fault.json> [--state dir]');
  const fault = readInput(args[0]);
  const result = runEvent(stateDir, { type: 'fail', fault });
  const step = result.steps[result.steps.length - 1];
  return {
    event: 'fail',
    fault: step.fault,
    preempted: step.preempted,
    keptLocked: step.keptLocked,
    revocations: step.revocations,
    replanned: step.replanned,
    plan: result.plan,
  };
}

function cmdRestore(args, stateDir) {
  if (args.length !== 1) throw new UsageError('usage: calsched restore <faultId> [--state dir]');
  const result = runEvent(stateDir, { type: 'restore', faultId: args[0] });
  const step = result.steps[result.steps.length - 1];
  return { event: 'restore', fault: step.fault, proof: step.proof, replanned: step.replanned, plan: result.plan };
}

function main(argv, io = {}) {
  const writeOut = io.stdout || ((s) => process.stdout.write(s));
  const writeErr = io.stderr || ((s) => process.stderr.write(s));
  try {
    const { args, state } = parseArgs(argv);
    const cmd = args.shift();
    let out;
    if (cmd === 'ingest') out = cmdIngest(args, state);
    else if (cmd === 'plan') out = cmdPlan(args, state);
    else if (cmd === 'correct') out = cmdCorrect(args, state);
    else if (cmd === 'fail') out = cmdFail(args, state);
    else if (cmd === 'restore') out = cmdRestore(args, state);
    else {
      throw new UsageError(`unknown command ${cmd}; expected ingest|plan|correct|fail|restore`);
    }
    writeOut(JSON.stringify(out, null, 2) + '\n');
    return 0;
  } catch (e) {
    writeErr(`error: ${e.message}\n`);
    return e.exitCode || 1;
  }
}

module.exports = { main };
