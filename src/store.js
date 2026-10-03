import fs from 'node:fs';
import path from 'node:path';
import { INITIAL_PROOF, computeProof } from './proof.js';
import { applyAllocation, planRound } from './scheduler.js';

const EPS = 1e-9;

export function loadInput(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'input.json'), 'utf8'));
}

export function initialState(input) {
  const remaining = {};
  const waits = {};
  for (const b of input.batches ?? []) {
    remaining[b.id] = b.amount;
    waits[b.id] = 0;
  }
  return { nextRound: 1, remaining, waits, proof: INITIAL_PROOF };
}

export function roundName(index) {
  return `round-${String(index).padStart(6, '0')}`;
}

export function scanRounds(dir) {
  const roundsDir = path.join(dir, 'rounds');
  const committed = [];
  const incomplete = [];
  if (fs.existsSync(roundsDir)) {
    for (const name of fs.readdirSync(roundsDir).sort()) {
      const rd = path.join(roundsDir, name);
      if (!fs.statSync(rd).isDirectory()) continue;
      if (fs.existsSync(path.join(rd, 'commit.marker'))) committed.push(name);
      else incomplete.push(name);
    }
  }
  return { committed, incomplete };
}

export function readRound(dir, name) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'rounds', name, 'round.json'), 'utf8'));
}

export function replay(input, rounds) {
  const state = initialState(input);
  for (const round of rounds) {
    applyAllocation(input, state.remaining, state.waits, round.allocations, round.index);
    state.proof = round.proof;
    state.nextRound = round.index + 1;
  }
  return state;
}

// Committed state is always derived from input + rounds that carry a
// commit.marker; state.json is only a cache that verify cross-checks.
export function loadState(dir) {
  const input = loadInput(dir);
  const { committed } = scanRounds(dir);
  return replay(input, committed.map((n) => readRound(dir, n)));
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

// Commit protocol: write round.json, fsync, then commit.marker, fsync, then
// the state cache. A crash between round.json and commit.marker leaves a
// partial round that recover() rolls back in full.
export function commitRound(dir, round, state) {
  const roundsDir = path.join(dir, 'rounds');
  fs.mkdirSync(roundsDir, { recursive: true });
  const rd = path.join(roundsDir, roundName(round.index));
  fs.mkdirSync(rd, { recursive: true });
  writeFileAtomic(path.join(rd, 'round.json'), `${JSON.stringify(round, null, 2)}\n`);
  fsyncDir(rd);
  // --- crash fault point: round dir written, commit.marker not yet written ---
  writeFileAtomic(path.join(rd, 'commit.marker'), `${round.proof}\n`);
  fsyncDir(rd);
  fsyncDir(roundsDir);
  writeFileAtomic(path.join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  fsyncDir(dir);
}

export function commitNext(dir) {
  const input = loadInput(dir);
  const state = loadState(dir);
  if (Object.keys(state.remaining).length === 0) return null;
  const planned = planRound(input, state.remaining, state.waits, state.nextRound);
  const core = { index: state.nextRound, allocations: planned.allocations, used: planned.used };
  const proof = computeProof(state.proof, core);
  const round = { ...core, proof };
  const remaining = { ...state.remaining };
  const waits = { ...state.waits };
  applyAllocation(input, remaining, waits, planned.allocations, state.nextRound);
  const nextState = { nextRound: state.nextRound + 1, remaining, waits, proof };
  commitRound(dir, round, nextState);
  return { round, state: nextState };
}

export function recover(dir) {
  const input = loadInput(dir);
  const { committed, incomplete } = scanRounds(dir);
  const rolledBack = [];
  for (const name of incomplete) {
    fs.rmSync(path.join(dir, 'rounds', name), { recursive: true, force: true });
    rolledBack.push(name);
  }
  const state = replay(input, committed.map((n) => readRound(dir, n)));
  writeFileAtomic(path.join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
  return { rolledBack, committed: committed.length, state };
}

export function verify(dir) {
  const errors = [];
  const input = loadInput(dir);
  const { committed, incomplete } = scanRounds(dir);
  if (incomplete.length > 0) {
    errors.push({ code: 'PARTIAL_COMMIT', message: `round dirs without commit.marker: ${incomplete.join(', ')}` });
  }
  const groups = new Map();
  for (const b of input.batches ?? []) {
    if (b.group) {
      if (!groups.has(b.group)) groups.set(b.group, new Set());
      groups.get(b.group).add(b.id);
    }
  }
  const groupSettled = new Map();
  for (const g of groups.keys()) groupSettled.set(g, { members: new Set(), rounds: new Set() });

  const state = initialState(input);
  let prevProof = state.proof;
  committed.forEach((name, i) => {
    const rd = path.join(dir, 'rounds', name);
    const round = JSON.parse(fs.readFileSync(path.join(rd, 'round.json'), 'utf8'));
    const marker = fs.readFileSync(path.join(rd, 'commit.marker'), 'utf8').trim();
    if (marker !== round.proof) {
      errors.push({ code: 'PARTIAL_COMMIT', message: `${name}: commit.marker does not match round proof` });
    }
    if (round.index !== i + 1) {
      errors.push({ code: 'PARTIAL_COMMIT', message: `${name}: expected round index ${i + 1}, got ${round.index}` });
    }
    const core = { index: round.index, allocations: round.allocations, used: round.used };
    if (computeProof(prevProof, core) !== round.proof) {
      errors.push({ code: 'PARTIAL_COMMIT', message: `${name}: proof chain broken` });
    }
    const sum = round.allocations.reduce((s, a) => s + a.amount, 0);
    if (Math.abs(sum - round.used) > EPS) {
      errors.push({ code: 'PARTIAL_COMMIT', message: `${name}: used ${round.used} != allocation sum ${sum}` });
    }
    if (sum > input.capacity + EPS) {
      errors.push({ code: 'WINDOW_FULL', message: `${name}: settled ${sum} exceeds capacity ${input.capacity}` });
    }
    const perInst = {};
    for (const a of round.allocations) {
      perInst[a.institution] = (perInst[a.institution] ?? 0) + a.amount;
      const left = state.remaining[a.batch] ?? 0;
      if (!(a.amount > 0) || a.amount > left + EPS) {
        errors.push({ code: 'PARTIAL_COMMIT', message: `${name}: batch ${a.batch} settled ${a.amount} with only ${left} remaining` });
      }
    }
    for (const [inst, amt] of Object.entries(perInst)) {
      const quota = input.institutions?.[inst]?.quota ?? 0;
      if (amt > quota + EPS) {
        errors.push({ code: 'QUOTA', message: `${name}: institution ${inst} settled ${amt} over quota ${quota}` });
      }
    }
    for (const a of round.allocations) {
      if (a.group && groups.has(a.group)) {
        const gs = groupSettled.get(a.group);
        gs.members.add(a.batch);
        gs.rounds.add(round.index);
      }
    }
    applyAllocation(input, state.remaining, state.waits, round.allocations, round.index);
    state.proof = round.proof;
    state.nextRound = round.index + 1;
    prevProof = round.proof;
  });
  for (const [g, gs] of groupSettled) {
    if (gs.members.size === 0) continue;
    if (gs.members.size !== groups.get(g).size || gs.rounds.size !== 1) {
      errors.push({ code: 'ATOMIC_SPLIT', message: `atomic group ${g} settled partially or across rounds` });
    }
  }
  const stateFile = path.join(dir, 'state.json');
  if (fs.existsSync(stateFile)) {
    const cached = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (JSON.stringify(cached) !== JSON.stringify(state)) {
      errors.push({ code: 'STATE_MISMATCH', message: 'state.json does not match replay of committed rounds' });
    }
  }
  return { ok: errors.length === 0, errors, rounds: committed.length, proof: state.proof, state };
}
