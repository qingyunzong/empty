// Brute-force reference: enumerate every person assignment and every
// per-person task permutation, evaluate the earliest feasible schedule,
// and keep the lexicographic (makespan, totalTravel) optimum.

function permutations(list) {
  if (list.length <= 1) return [list.slice()];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const rest = list.slice(0, i).concat(list.slice(i + 1));
    for (const perm of permutations(rest)) out.push([list[i], ...perm]);
  }
  return out;
}

export function bruteForceOptimum(input) {
  const { tasks, inspectors } = input;
  const n = tasks.length;
  const travel = (a, b) => (a === b ? 0 : (input.travel?.[a]?.[b] ?? 0));
  const compat = tasks.map((t) =>
    inspectors
      .map((_, pi) => pi)
      .filter((pi) => t.skills.every((s) => inspectors[pi].skills.includes(s))));

  let best = null;
  const personOf = new Array(n).fill(0);

  function consider(makespan, trav) {
    if (!best || makespan < best.makespan ||
        (makespan === best.makespan && trav < best.travel)) {
      best = { makespan, travel: trav };
    }
  }

  function evalAssignment() {
    const groups = new Map();
    for (let i = 0; i < n; i++) {
      const p = personOf[i];
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(i);
    }
    const permsPerGroup = [...groups.values()].map(permutations);
    const chosen = new Array(permsPerGroup.length);
    function rec(k) {
      if (k === permsPerGroup.length) {
        let makespan = 0;
        let trav = 0;
        for (const seq of chosen) {
          let prevEnd = 0;
          let prevZone = null;
          for (const t of seq) {
            let s = tasks[t].window[0];
            if (prevZone !== null) {
              s = Math.max(s, prevEnd + travel(prevZone, tasks[t].zone));
              trav += travel(prevZone, tasks[t].zone);
            }
            if (s > tasks[t].window[1]) return; // infeasible permutation
            prevEnd = s + tasks[t].duration;
            prevZone = tasks[t].zone;
            if (prevEnd > makespan) makespan = prevEnd;
          }
        }
        consider(makespan, trav);
        return;
      }
      for (const perm of permsPerGroup[k]) {
        chosen[k] = perm;
        rec(k + 1);
      }
    }
    rec(0);
  }

  function assign(i) {
    if (i === n) {
      evalAssignment();
      return;
    }
    for (const p of compat[i]) {
      personOf[i] = p;
      assign(i + 1);
    }
  }
  assign(0);
  return best;
}

// Independent feasibility checker for a produced assignment list.
export function checkFeasible(input, assignments) {
  const { tasks, inspectors } = input;
  const travel = (a, b) => (a === b ? 0 : (input.travel?.[a]?.[b] ?? 0));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const skillsOf = new Map(inspectors.map((p) => [p.id, new Set(p.skills)]));
  const perPerson = new Map();
  let makespan = 0;
  for (const a of assignments) {
    const t = byId.get(a.task);
    if (!t) throw new Error(`unknown task ${a.task}`);
    const skills = skillsOf.get(a.person);
    if (!skills) throw new Error(`unknown person ${a.person}`);
    for (const s of t.skills) {
      if (!skills.has(s)) throw new Error(`${a.person} lacks skill ${s} for ${a.task}`);
    }
    if (!Number.isInteger(a.start)) throw new Error(`non-integer start for ${a.task}`);
    if (a.start < t.window[0] || a.start > t.window[1]) {
      throw new Error(`${a.task} starts at ${a.start} outside window ${t.window}`);
    }
    makespan = Math.max(makespan, a.start + t.duration);
    if (!perPerson.has(a.person)) perPerson.set(a.person, []);
    perPerson.get(a.person).push(a);
  }
  let totalTravel = 0;
  for (const list of perPerson.values()) {
    list.sort((x, y) => x.start - y.start);
    for (let i = 1; i < list.length; i++) {
      const prev = byId.get(list[i - 1].task);
      const cur = byId.get(list[i].task);
      const tij = travel(prev.zone, cur.zone);
      if (list[i - 1].start + prev.duration + tij > list[i].start) {
        throw new Error(`overlap between ${prev.id} and ${cur.id}`);
      }
      totalTravel += tij;
    }
  }
  return { makespan, totalTravel };
}
