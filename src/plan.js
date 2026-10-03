import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { lex } from './lexer.js';
import { parse } from './parser.js';
import { check, objectiveToString, DENOM } from './checker.js';
import { solveSite, evalObjective, objectiveMetrics } from './scheduler.js';
import { compileSite, link } from './compiler.js';
import { VM } from './vm.js';

export function fmtTime(minutes) {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

export function round6(x) {
  return Math.round(x * 1e6) / 1e6;
}

function sitePlan(site, res) {
  const p = {
    name: site.name,
    slots: site.slots,
    slotMinutes: site.slotMinutes,
    objective: objectiveToString(site.objective),
    status: res.status,
    budgetsExceeded: res.budgetsExceeded,
    costBudget: site.costBudget,
    carbonBudget: site.carbonBudget,
    optimum: null,
  };
  if (res.optimum) {
    const o = res.optimum;
    p.optimum = {
      cost: round6(o.costNum / DENOM),
      costNum: String(o.costNum),
      carbon: round6(o.carbonNum / DENOM),
      carbonNum: String(o.carbonNum),
      peakKW: o.peakW / 1000,
      signature: o.signature,
      assignments: site.tasks.map((t, i) => {
        const slots = o.slotLists[i];
        return {
          task: t.id,
          startSlot: slots[0],
          start: fmtTime(slots[0] * site.slotMinutes),
          end: fmtTime((slots[slots.length - 1] + 1) * site.slotMinutes),
          slots,
        };
      }),
      loadKW: o.load.map((w) => w / 1000),
    };
  }
  return p;
}

export function buildPlan(sourcePath, sourceText, model, results) {
  return {
    version: 1,
    generator: 'energy-scheduler/1',
    source: sourcePath,
    sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
    sites: results.map(({ site, res }) => sitePlan(site, res)),
  };
}

function runsOf(slots) {
  const runs = [];
  let start = slots[0];
  for (let k = 1; k <= slots.length; k += 1) {
    if (k === slots.length || slots[k] !== slots[k - 1] + 1) {
      runs.push([start, slots[k - 1] + 1]);
      if (k < slots.length) start = slots[k];
    }
  }
  return runs;
}

function validateAssignment(site, task, assignment, problems) {
  const slots = assignment.slots;
  const label = `site '${site.name}' task '${task.id}'`;
  if (!Array.isArray(slots) || slots.length !== task.durationSlots) {
    problems.push(`${label}: slot count ${Array.isArray(slots) ? slots.length : '?'} != duration ${task.durationSlots}`);
    return null;
  }
  const sorted = slots.slice().sort((a, b) => a - b);
  for (let k = 0; k < sorted.length; k += 1) {
    const s = sorted[k];
    if (!Number.isInteger(s) || s < task.winStart || s >= task.winEnd) {
      problems.push(`${label}: slot ${s} is outside the task window`);
      return null;
    }
    if (k > 0 && sorted[k] === sorted[k - 1]) {
      problems.push(`${label}: duplicate slot ${s}`);
      return null;
    }
    if (site.blocked[s]) {
      problems.push(`${label}: slot ${s} falls in a maintenance window`);
      return null;
    }
  }
  const runs = runsOf(sorted);
  if (!task.interruptible && runs.length !== 1) {
    problems.push(`${label}: non-interruptible task is split into ${runs.length} runs`);
    return null;
  }
  const maxRuns = task.maxInterrupts == null ? task.durationSlots : task.maxInterrupts + 1;
  if (task.interruptible && runs.length > maxRuns) {
    problems.push(`${label}: ${runs.length - 1} interrupts exceed maxInterrupts`);
    return null;
  }
  return { slots: sorted, runs, first: sorted[0], last: sorted[sorted.length - 1] };
}

export function verifyPlan(planPath) {
  const problems = [];
  const plan = JSON.parse(readFileSync(planPath, 'utf8'));
  if (plan.version !== 1) problems.push(`unsupported plan version ${plan.version}`);
  const planDir = path.dirname(planPath);
  const sourcePath = path.resolve(planDir, plan.source);
  const sourceText = readFileSync(sourcePath, 'utf8');
  const hash = createHash('sha256').update(sourceText).digest('hex');
  if (hash !== plan.sourceSha256) {
    problems.push(`source '${plan.source}' hash mismatch (file changed since scheduling)`);
  }
  const model = check(parse(lex(sourceText, plan.source)));

  for (const planSite of plan.sites) {
    const site = model.sites.find((s) => s.name === planSite.name);
    if (!site) {
      problems.push(`site '${planSite.name}' not found in source`);
      continue;
    }
    const res = solveSite(site);
    if (res.status !== planSite.status) {
      problems.push(`site '${site.name}': status '${planSite.status}' != recomputed '${res.status}'`);
      continue;
    }
    if (!res.optimum) continue;
    const opt = planSite.optimum;
    if (!opt) {
      problems.push(`site '${site.name}': plan has no optimum but one exists`);
      continue;
    }

    const chosen = new Map();
    const seenTasks = new Set();
    for (const a of opt.assignments) {
      const task = site.tasks.find((t) => t.id === a.task);
      if (!task) {
        problems.push(`site '${site.name}': unknown task '${a.task}' in plan`);
        continue;
      }
      if (seenTasks.has(task.id)) {
        problems.push(`site '${site.name}': task '${task.id}' assigned twice`);
        continue;
      }
      seenTasks.add(task.id);
      const pat = validateAssignment(site, task, a, problems);
      if (pat) chosen.set(task.id, pat);
    }
    for (const t of site.tasks) {
      if (!seenTasks.has(t.id)) problems.push(`site '${site.name}': task '${t.id}' is not scheduled`);
    }
    for (const t of site.tasks) {
      const ct = chosen.get(t.id);
      if (!ct) continue;
      for (const other of site.tasks) {
        const co = chosen.get(other.id);
        if (!co || other.id === t.id) continue;
        if (t.after.includes(other.id) && ct.first <= co.last) {
          problems.push(`site '${site.name}': task '${t.id}' violates 'after ${other.id}'`);
        }
        if (t.before.includes(other.id) && ct.last >= co.first) {
          problems.push(`site '${site.name}': task '${t.id}' violates 'before ${other.id}'`);
        }
      }
    }

    const program = compileSite(site);
    const vm = new VM(site.slots);
    const code = link(program, site.tasks.map((t) => (chosen.get(t.id) ? chosen.get(t.id).runs : [])));
    const r = vm.run(code);
    if (!r.ok) problems.push(`site '${site.name}': VM check failed (${r.reason} at slot ${r.slot})`);

    let costNum = 0;
    let carbonNum = 0;
    for (let s = 0; s < site.slots; s += 1) {
      costNum += vm.load[s] * site.priceMicro[s];
      carbonNum += vm.load[s] * site.carbonMicro[s];
      if (Math.abs(vm.load[s] / 1000 - (opt.loadKW[s] ?? NaN)) > 1e-9) {
        problems.push(`site '${site.name}': reported load at slot ${s} does not match assignments`);
        break;
      }
    }
    costNum *= site.slotMinutes;
    carbonNum *= site.slotMinutes;
    if (String(costNum) !== opt.costNum) {
      problems.push(`site '${site.name}': reported cost does not match the assignments`);
    }
    if (String(carbonNum) !== opt.carbonNum) {
      problems.push(`site '${site.name}': reported carbon does not match the assignments`);
    }
    if (Math.abs(vm.peakW() / 1000 - opt.peakKW) > 1e-9) {
      problems.push(`site '${site.name}': reported peak does not match the assignments`);
    }

    const planObjective = evalObjective(site.objective, objectiveMetrics(site, {
      costNum, carbonNum, peakW: vm.peakW(),
    }));
    const bestObjective = evalObjective(site.objective, objectiveMetrics(site, res.optimum));
    if (planObjective !== bestObjective || vm.peakW() !== res.optimum.peakW) {
      problems.push(`site '${site.name}': plan is not optimal (best cost is ${round6(res.optimum.costNum / DENOM)})`);
    }
  }
  return { ok: problems.length === 0, problems };
}
