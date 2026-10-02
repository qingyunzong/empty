import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const BASE = 1_700_000_000_000;
export const MIN = 60_000;

export function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'dispatch-test-'));
}

export function writeJsonl(dir, events, name = 'events.jsonl') {
  mkdirSync(dir, { recursive: true });
  const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(join(dir, name), body);
}

// Capture stdout/stderr of an in-process CLI run.
export function captureIo() {
  const io = { out: '', err: '' };
  io.stdout = { write(s) { io.out += s; } };
  io.stderr = { write(s) { io.err += s; } };
  return io;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Independent brute-force reference: enumerate every total function from
// carriers to (windows + unassigned), keep only budget-feasible ones, and
// collect all lexicographically optimal (score, count) assignments.
export function bruteForceSolve(carriers, windows, scoreOf) {
  const ids = carriers.map((c) => c.carrier).sort();
  const byId = new Map(carriers.map((c) => [c.carrier, c]));
  let best = null;
  const solutions = new Set();

  function rec(i, remaining, score, count, pick) {
    if (i === ids.length) {
      const key = ids.map((id, k) => `${id}=${pick[k]}`).join(',');
      if (best === null || score > best.score || (score === best.score && count > best.count)) {
        best = { score, count };
        solutions.clear();
      }
      if (score === best.score && count === best.count) solutions.add(key);
      return;
    }
    const carrier = byId.get(ids[i]);
    pick.push('-');
    rec(i + 1, remaining, score, count, pick);
    pick.pop();
    for (let w = 0; w < windows.length; w += 1) {
      const win = windows[w];
      if (win.op !== carrier.op || win.windowEnd < carrier.eventTs) continue;
      if (remaining[w] < carrier.qty) continue;
      remaining[w] -= carrier.qty;
      pick.push(win.tool);
      rec(i + 1, remaining, score + (scoreOf(carrier.lot) ?? 0), count + 1, pick);
      pick.pop();
      remaining[w] += carrier.qty;
    }
  }
  rec(0, windows.map((w) => w.cap), 0, 0, []);
  return { objective: best ?? { score: 0, count: 0 }, solutions };
}

// Serialize a solveAll() solution the same way bruteForceSolve does.
export function serializeSolution(solution, allCarrierIds) {
  const assigned = new Map(solution.assignments.map((a) => [a.carrier, a.tool]));
  return [...allCarrierIds].sort().map((id) => `${id}=${assigned.get(id) ?? '-'}`).join(',');
}
