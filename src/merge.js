import { canonical } from './event.js';
import { readLog, appendEvent } from './store.js';
import { project } from './project.js';

// 双向合并：互相补齐缺失事件（按 id 去重），双方各自重算确定性投影。
export function syncStores(dirA, dirB) {
  const eventsA = readLog(dirA).map((r) => r.event);
  const eventsB = readLog(dirB).map((r) => r.event);
  const idsA = new Set(eventsA.map((e) => e.id));
  const idsB = new Set(eventsB.map((e) => e.id));
  let toA = 0;
  let toB = 0;
  for (const ev of eventsB) {
    if (!idsA.has(ev.id)) {
      appendEvent(dirA, ev);
      toA += 1;
    }
  }
  for (const ev of eventsA) {
    if (!idsB.has(ev.id)) {
      appendEvent(dirB, ev);
      toB += 1;
    }
  }
  const projA = project(readLog(dirA).map((r) => r.event));
  const projB = project(readLog(dirB).map((r) => r.event));
  const converged = canonical(projA.orders) === canonical(projB.orders);
  const seen = new Set();
  const conflicts = [];
  for (const c of [...projA.conflicts, ...projB.conflicts]) {
    const key = canonical(c);
    if (!seen.has(key)) {
      seen.add(key);
      conflicts.push(c);
    }
  }
  const heldCount = [...projA.decisions.values()].filter((d) => d.status === 'held').length;
  return {
    transferred: toA + toB,
    converged,
    pending: projA.pending,
    conflicts,
    heldCount,
  };
}
