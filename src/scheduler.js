// Finite-domain scheduler: tank id and start time domains per task,
// propagation of capacity / compatibility / cleaning-boundary constraints,
// backtracking search over task ordering with a node budget.

import { isCompatible } from './problem.js';

function copyDomains(domains) {
  const copy = new Map();
  for (const [key, value] of domains) copy.set(key, new Set(value));
  return copy;
}

export class Scheduler {
  constructor(problem, { holds = [] } = {}) {
    this.problem = problem;
    this.cleaningMap = new Map();
    for (const rule of problem.cleaning) {
      this.cleaningMap.set(`${rule.from}→${rule.to}`, rule.time);
    }
    this.holds = new Map();
    for (const hold of holds) this.holds.set(hold.id, { ...hold });
    this._rebuild();
  }

  cleaningTime(fromMaterial, toMaterial) {
    if (fromMaterial === null || toMaterial === null) return 0;
    if (fromMaterial === toMaterial) return 0;
    return this.cleaningMap.get(`${fromMaterial}→${toMaterial}`) ?? 0;
  }

  _units() {
    const taskUnits = this.problem.tasks.map((task) => ({
      id: task.id,
      kind: 'task',
      material: task.material,
      minCapacity: task.minCapacity,
      maxCapacity: task.maxCapacity,
      earliestStart: task.earliestStart,
      latestStart: task.latestStart,
      duration: task.duration,
      locked: task.locked,
      tank: task.tank,
      start: task.start,
    }));
    const holdUnits = [...this.holds.values()].map((hold) => ({
      id: `hold:${hold.id}`,
      kind: 'hold',
      holdId: hold.id,
      material: hold.material,
      minCapacity: 0,
      maxCapacity: Number.MAX_SAFE_INTEGER,
      earliestStart: hold.start,
      latestStart: hold.start,
      duration: hold.duration,
      locked: true,
      tank: hold.tank,
      start: hold.start,
    }));
    return [...taskUnits, ...holdUnits];
  }

  _rebuild() {
    this.units = this._units();
    this.tankDom = new Map();
    this.startDom = new Map();
    this.fixed = new Map();
    for (const unit of this.units) {
      const tanks = this.problem.tanks
        .filter((tank) =>
          tank.capacity >= unit.minCapacity &&
          tank.capacity <= unit.maxCapacity &&
          isCompatible(this.problem, unit.material, tank.material))
        .map((tank) => tank.id);
      this.tankDom.set(unit.id, new Set(tanks));
      const lo = unit.earliestStart;
      const hi = Math.min(
        unit.latestStart ?? Number.MAX_SAFE_INTEGER,
        this.problem.horizon - unit.duration,
      );
      const starts = new Set();
      for (let s = lo; s <= hi; s += 1) starts.add(s);
      this.startDom.set(unit.id, starts);
      if (unit.locked) this.fixed.set(unit.id, { tank: unit.tank, start: unit.start });
    }
    for (const [id, assignment] of this.fixed) {
      this.tankDom.set(id, new Set([assignment.tank]));
      this.startDom.set(id, new Set([assignment.start]));
    }
    this.consistent = this._propagate(this.tankDom, this.startDom);
  }

  _separated(unitA, startA, unitB, startB) {
    const endA = startA + unitA.duration;
    const endB = startB + unitB.duration;
    return (
      endA + this.cleaningTime(unitA.material, unitB.material) <= startB ||
      endB + this.cleaningTime(unitB.material, unitA.material) <= startA
    );
  }

  // Arc consistency on pairwise cleaning/separation constraints.
  // Returns false on any domain wipeout. Mutates the passed domain maps.
  _propagate(tankDom, startDom) {
    const units = this.units;
    for (const unit of units) {
      if (tankDom.get(unit.id).size === 0 || startDom.get(unit.id).size === 0) return false;
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < units.length; i += 1) {
        for (let j = i + 1; j < units.length; j += 1) {
          const a = units[i];
          const b = units[j];
          const tanksA = tankDom.get(a.id);
          const tanksB = tankDom.get(b.id);
          let shared = false;
          let avoidable = false;
          for (const ta of tanksA) {
            if (tanksB.has(ta)) shared = true;
            for (const tb of tanksB) {
              if (ta !== tb) { avoidable = true; break; }
            }
            if (avoidable) break;
          }
          if (!shared || avoidable) continue;
          for (const [first, second] of [[a, b], [b, a]]) {
            const startsFirst = startDom.get(first.id);
            const startsSecond = startDom.get(second.id);
            for (const s of [...startsFirst]) {
              let supported = false;
              for (const t of startsSecond) {
                if (this._separated(first, s, second, t)) { supported = true; break; }
              }
              if (!supported) {
                startsFirst.delete(s);
                changed = true;
              }
            }
            if (startsFirst.size === 0) return false;
          }
        }
      }
    }
    return true;
  }

  // Temporary occupation. On propagation failure the newly added propagation
  // is rolled back; locked tasks and earlier holds are untouched.
  hold(occupation) {
    if (this.holds.has(occupation.id)) {
      return { ok: false, id: occupation.id, reason: 'duplicate-hold' };
    }
    if (!this.problem.tanks.some((tank) => tank.id === occupation.tank)) {
      return { ok: false, id: occupation.id, reason: 'unknown-tank' };
    }
    this.holds.set(occupation.id, { ...occupation });
    this._rebuild();
    if (!this.consistent) {
      this.holds.delete(occupation.id);
      this._rebuild();
      return { ok: false, id: occupation.id, reason: 'propagation-failed' };
    }
    return { ok: true, id: occupation.id };
  }

  release(holdId) {
    if (!this.holds.has(holdId)) return { ok: false, id: holdId, reason: 'not-found' };
    this.holds.delete(holdId);
    this._rebuild();
    return { ok: true, id: holdId };
  }

  solve({ budget = Number.MAX_SAFE_INTEGER } = {}) {
    if (!this.consistent) return { status: 'infeasible' };
    let nodes = 0;
    const units = this.units;

    const search = (tankDom, startDom, fixed) => {
      let pick = null;
      let pickScore = Infinity;
      for (const unit of units) {
        if (fixed.has(unit.id)) continue;
        const score = tankDom.get(unit.id).size * startDom.get(unit.id).size;
        if (score < pickScore) { pickScore = score; pick = unit; }
      }
      if (!pick) return { status: 'feasible', fixed };
      if (nodes >= budget) {
        return {
          status: 'unknown',
          pending: units.filter((u) => u.kind === 'task' && !fixed.has(u.id)).map((u) => u.id),
        };
      }
      nodes += 1;
      const tanks = [...tankDom.get(pick.id)].sort();
      const starts = [...startDom.get(pick.id)].sort((x, y) => x - y);
      for (const tank of tanks) {
        for (const start of starts) {
          const nextTanks = copyDomains(tankDom);
          const nextStarts = copyDomains(startDom);
          nextTanks.set(pick.id, new Set([tank]));
          nextStarts.set(pick.id, new Set([start]));
          if (!this._propagate(nextTanks, nextStarts)) continue;
          const nextFixed = new Map(fixed);
          nextFixed.set(pick.id, { tank, start });
          const result = search(nextTanks, nextStarts, nextFixed);
          if (result.status !== 'infeasible') return result;
        }
      }
      return { status: 'infeasible' };
    };

    const result = search(copyDomains(this.tankDom), copyDomains(this.startDom), new Map(this.fixed));
    if (result.status === 'feasible') {
      const assignments = [];
      for (const unit of units) {
        if (unit.kind !== 'task') continue;
        const assignment = result.fixed.get(unit.id);
        assignments.push({
          task: unit.id,
          tank: assignment.tank,
          start: assignment.start,
          end: assignment.start + unit.duration,
        });
      }
      assignments.sort((a, b) => a.task.localeCompare(b.task));
      return { status: 'feasible', assignments };
    }
    return result;
  }
}
