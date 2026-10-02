import fs from 'node:fs';
import path from 'node:path';
import { ClearingError } from './errors.js';
import { normalizeScenario, canonicalScenario } from './scenario.js';
import { planSchedule, computeWaits, validateRounds } from './scheduler.js';
import { proofOf } from './proof.js';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, JSON.stringify(value, null, 2));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
}

function writeMarker(file, data) {
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export function stateProof(sc, rounds, waits) {
  return proofOf({ scenario: canonicalScenario(sc), rounds, waits });
}

export function planToDir(stateDir, scenarioInput, opts = {}) {
  const { scenario: sc, rounds, waits } = planSchedule(scenarioInput, opts);
  fs.mkdirSync(stateDir, { recursive: true });
  const proof = stateProof(sc, rounds, waits);
  writeJsonAtomic(path.join(stateDir, 'scenario.json'), canonicalScenario(sc));
  writeJsonAtomic(path.join(stateDir, 'plan.json'), { rounds, waits, proof });
  writeJsonAtomic(path.join(stateDir, 'state.json'), { committed: 0, proof: null });
  return { rounds, waits, proof };
}

export function commitRounds(stateDir, { maxCommits = Infinity, crashAfterWrite = false } = {}) {
  const planPath = path.join(stateDir, 'plan.json');
  if (!fs.existsSync(planPath)) throw new ClearingError('INVALID', 'no plan found; run plan first');
  const plan = readJson(planPath);
  const sc = normalizeScenario(readJson(path.join(stateDir, 'scenario.json')));
  const statePath = path.join(stateDir, 'state.json');
  const state = fs.existsSync(statePath) ? readJson(statePath) : { committed: 0 };
  const pending = plan.rounds.slice(state.committed);
  const target = pending.slice(0, Math.min(maxCommits, pending.length));
  if (target.length === 0) {
    const committedRounds = plan.rounds.slice(0, state.committed);
    const waits = computeWaits(sc, committedRounds);
    return { crashed: false, committed: state.committed, rounds: committedRounds, waits, proof: stateProof(sc, committedRounds, waits) };
  }
  const roundsDir = path.join(stateDir, 'rounds');
  fs.mkdirSync(roundsDir, { recursive: true });
  let committed = state.committed;
  for (let i = 0; i < target.length; i += 1) {
    const round = target[i];
    const crashHere = crashAfterWrite && i === target.length - 1;
    const dir = path.join(roundsDir, `round-${String(round.round).padStart(4, '0')}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    writeJsonAtomic(path.join(dir, 'allocations.json'), round);
    if (crashHere) {
      // Crash point: round directory written, commit.marker not yet written.
      return { crashed: true, round: round.round, committed };
    }
    writeMarker(path.join(dir, 'commit.marker'), `${proofOf(round)}\n`);
    committed += 1;
    const committedRounds = plan.rounds.slice(0, committed);
    const waits = computeWaits(sc, committedRounds);
    writeJsonAtomic(statePath, { committed, proof: stateProof(sc, committedRounds, waits) });
  }
  const committedRounds = plan.rounds.slice(0, committed);
  const waits = computeWaits(sc, committedRounds);
  return { crashed: false, committed, rounds: committedRounds, waits, proof: stateProof(sc, committedRounds, waits) };
}

function scanRoundDirs(stateDir) {
  const roundsDir = path.join(stateDir, 'rounds');
  const committed = [];
  const uncommitted = [];
  if (!fs.existsSync(roundsDir)) return { committed, uncommitted };
  for (const name of fs.readdirSync(roundsDir).sort()) {
    const dir = path.join(roundsDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const allocPath = path.join(dir, 'allocations.json');
    const markerPath = path.join(dir, 'commit.marker');
    if (!fs.existsSync(markerPath)) {
      uncommitted.push({ name, dir });
      continue;
    }
    if (!fs.existsSync(allocPath)) {
      throw new ClearingError('PARTIAL_COMMIT', `${name}: commit.marker exists but allocations.json is missing`);
    }
    const round = readJson(allocPath);
    const marker = fs.readFileSync(markerPath, 'utf8').trim();
    if (marker !== proofOf(round)) {
      throw new ClearingError('PARTIAL_COMMIT', `${name}: commit.marker does not match allocations.json`);
    }
    committed.push(round);
  }
  committed.sort((a, b) => a.round - b.round);
  return { committed, uncommitted };
}

export function recoverState(stateDir) {
  const sc = normalizeScenario(readJson(path.join(stateDir, 'scenario.json')));
  const { committed, uncommitted } = scanRoundDirs(stateDir);
  const rolledBack = [];
  for (const u of uncommitted) {
    fs.rmSync(u.dir, { recursive: true, force: true });
    rolledBack.push(u.name);
  }
  const waits = computeWaits(sc, committed);
  const proof = stateProof(sc, committed, waits);
  writeJsonAtomic(path.join(stateDir, 'state.json'), { committed: committed.length, proof });
  return { rounds: committed, waits, proof, rolledBack };
}

export function verifyState(stateDir) {
  const sc = normalizeScenario(readJson(path.join(stateDir, 'scenario.json')));
  const { committed, uncommitted } = scanRoundDirs(stateDir);
  if (uncommitted.length > 0) {
    throw new ClearingError('PARTIAL_COMMIT', `round directories without commit.marker: ${uncommitted.map((u) => u.name).join(', ')}`);
  }
  validateRounds(sc, committed);
  const waits = computeWaits(sc, committed);
  const proof = stateProof(sc, committed, waits);
  const statePath = path.join(stateDir, 'state.json');
  if (fs.existsSync(statePath)) {
    const state = readJson(statePath);
    if (state.committed !== committed.length) {
      throw new ClearingError('PARTIAL_COMMIT', `state records ${state.committed} committed rounds but ${committed.length} are present`);
    }
    if (state.proof !== null && state.proof !== undefined && state.proof !== proof) {
      throw new ClearingError('PARTIAL_COMMIT', 'state proof does not match recomputed proof');
    }
  }
  return { ok: true, rounds: committed, waits, proof };
}
