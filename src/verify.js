// Item-by-item certificate verification.
// verifySolution(instance, solution) re-simulates the machine timelines from
// the reported slices and returns { ok, checks: [{name, ok, detail}] }.
// Every constraint of the model maps to one named check, so a certificate can
// be audited line by line.

export function verifySolution(inst, sol) {
  const checks = [];
  const add = (name, ok, detail = '') => {
    checks.push({ name, ok: !!ok, detail: String(detail) });
    return !!ok;
  };
  const finish = () => ({ ok: checks.every((c) => c.ok), checks });

  if (!sol || typeof sol !== 'object') {
    add('status-optimal', false, 'solution is not an object');
    return finish();
  }
  if (!add('status-optimal', sol.status === 'optimal', `status=${sol.status}`)) return finish();

  const orderIndex = new Map(inst.orders.map((o, i) => [o.id, i]));
  const shiftOfSlot = new Int32Array(Math.max(inst.horizon, 1)).fill(-1);
  inst.shifts.forEach((s, si) => { for (let t = s.start; t < s.end; t++) shiftOfSlot[t] = si; });

  // ---- collect slices per machine --------------------------------------
  const slicesByMachine = new Map(inst.machines.map((m) => [m.id, []]));
  let machinesOk = Array.isArray(sol.machines);
  if (machinesOk) {
    for (const ms of sol.machines) {
      if (!ms || typeof ms.id !== 'string' || !slicesByMachine.has(ms.id) || !Array.isArray(ms.slices)) {
        machinesOk = false;
        break;
      }
      slicesByMachine.set(ms.id, ms.slices);
    }
  }
  if (!add('machines-section-wellformed', machinesOk)) return finish();

  let slicesOk = true;
  let sliceProblem = '';
  for (const [mid, slices] of slicesByMachine) {
    for (const s of slices) {
      const bad = !s || !Number.isInteger(s.start) || !Number.isInteger(s.end) ||
        s.start < 0 || s.end <= s.start ||
        (s.type !== 'production' && s.type !== 'changeover') ||
        (s.type === 'production' && !orderIndex.has(s.order)) ||
        (s.type === 'changeover' && (!orderIndex.has(s.preempted) || !orderIndex.has(s.by)));
      if (bad) { slicesOk = false; sliceProblem = `machine ${mid}: malformed slice ${JSON.stringify(s)}`; break; }
    }
    if (!slicesOk) break;
  }
  if (!add('slices-wellformed', slicesOk, sliceProblem)) return finish();

  let layoutOk = true;
  let layoutProblem = '';
  for (const [mid, slices] of slicesByMachine) {
    for (let i = 0; i < slices.length; i++) {
      if (i > 0 && slices[i].start < slices[i - 1].end) {
        layoutOk = false;
        layoutProblem = `machine ${mid}: slices overlap or are unsorted at slot ${slices[i].start}`;
        break;
      }
    }
    if (!layoutOk) break;
  }
  if (!add('machine-timelines-nonoverlapping', layoutOk, layoutProblem)) return finish();

  // ---- re-simulate ------------------------------------------------------
  const N = inst.orders.length;
  const remaining = inst.orders.map((o) => o.duration);
  const producedBefore = new Array(N).fill(false);
  const interrupted = new Array(N).fill(false);
  const preemptCount = new Array(N).fill(0);
  const completion = new Array(N).fill(-1);
  const orderMachine = new Array(N).fill(null);
  const usage = inst.shifts.map(() => new Map());
  const derivedEvents = [];

  const flags = {
    singleCompatibleMachine: true,
    releaseRespected: true,
    withinShifts: true,
    preemptionProtocol: true,
    interruptionOnlyByPreemption: true,
    preemptionLimit: true,
  };
  const problems = {};

  for (const m of inst.machines) {
    const slices = slicesByMachine.get(m.id);
    let loaded = null;    // order index whose mould is on the machine
    let pendingBy = null; // changeover just happened: next slice must be this order
    let prev = null;
    for (const s of slices) {
      if (s.type === 'changeover') {
        const b = loaded;
        const c = orderIndex.get(s.by);
        const pb = orderIndex.get(s.preempted);
        if (b === null || pb !== b) {
          flags.preemptionProtocol = false;
          problems.preemptionProtocol = `machine ${m.id} slot ${s.start}: changeover names preempted "${s.preempted}" but that order is not loaded/unfinished on the machine`;
        } else {
          if (!prev || prev.type !== 'production' || prev.end !== s.start) {
            flags.preemptionProtocol = false;
            problems.preemptionProtocol = `machine ${m.id} slot ${s.start}: changeover does not immediately follow the preempted order's segment`;
          }
          if (inst.orders[b].critical) {
            flags.preemptionProtocol = false;
            problems.preemptionProtocol = `machine ${m.id} slot ${s.start}: critical order ${s.preempted} may not be preempted`;
          }
          if (remaining[b] === 0) {
            flags.preemptionProtocol = false;
            problems.preemptionProtocol = `machine ${m.id} slot ${s.start}: order ${s.preempted} was already complete`;
          }
        }
        if (!inst.orders[c].critical) {
          flags.preemptionProtocol = false;
          problems.preemptionProtocol = `machine ${m.id} slot ${s.start}: preemption by non-critical order ${s.by}`;
        }
        if (inst.orders[c].release > s.end) {
          flags.preemptionProtocol = false;
          problems.preemptionProtocol = `machine ${m.id} slot ${s.start}: preempting order ${s.by} is not released by slot ${s.end}`;
        }
        if (b !== null) {
          preemptCount[b]++;
          if (preemptCount[b] > 2) {
            flags.preemptionLimit = false;
            problems.preemptionLimit = `order ${inst.orders[b].id} is preempted more than 2 times`;
          }
          interrupted[b] = true;
        }
        derivedEvents.push({ slot: s.start, machine: m.id, preempted: s.preempted, by: s.by });
        loaded = c;
        pendingBy = c;
      } else {
        const x = orderIndex.get(s.order);
        if (orderMachine[x] === null) {
          orderMachine[x] = m.id;
        } else if (orderMachine[x] !== m.id) {
          flags.singleCompatibleMachine = false;
          problems.singleCompatibleMachine = `order ${s.order} runs on more than one machine`;
        }
        if (!inst.orders[x].machines.includes(inst.machines.findIndex((mm) => mm.id === m.id))) {
          flags.singleCompatibleMachine = false;
          problems.singleCompatibleMachine = `order ${s.order} is not compatible with machine ${m.id}`;
        }
        if (pendingBy !== null) {
          if (x !== pendingBy || !prev || s.start !== prev.end) {
            flags.preemptionProtocol = false;
            problems.preemptionProtocol = `machine ${m.id} slot ${s.start}: changeover is not immediately followed by the preempting order's segment`;
          }
          pendingBy = null;
        } else if (loaded !== null && loaded !== x) {
          flags.interruptionOnlyByPreemption = false;
          problems.interruptionOnlyByPreemption =
            `machine ${m.id} slot ${s.start}: order ${inst.orders[loaded].id} left the machine unfinished without a critical preemption`;
        } else if (loaded === null && producedBefore[x] && remaining[x] > 0 && !interrupted[x]) {
          flags.interruptionOnlyByPreemption = false;
          problems.interruptionOnlyByPreemption =
            `machine ${m.id} slot ${s.start}: order ${s.order} resumes after leaving the machine without being preempted`;
        }
        interrupted[x] = false;
        producedBefore[x] = true;
        if (s.start < inst.orders[x].release) {
          flags.releaseRespected = false;
          problems.releaseRespected = `order ${s.order} produces at slot ${s.start} before its release ${inst.orders[x].release}`;
        }
        for (let t = s.start; t < s.end; t++) {
          const sh = t < shiftOfSlot.length ? shiftOfSlot[t] : -1;
          if (sh < 0) {
            flags.withinShifts = false;
            problems.withinShifts = `order ${s.order} produces at slot ${t} which is outside every shift`;
          } else {
            const fam = inst.orders[x].family;
            usage[sh].set(fam, (usage[sh].get(fam) ?? 0) + 1);
          }
        }
        remaining[x] -= s.end - s.start;
        if (remaining[x] === 0) {
          completion[x] = s.end;
          loaded = null;
        } else {
          loaded = x;
        }
      }
      prev = s;
    }
    if (pendingBy !== null) {
      flags.preemptionProtocol = false;
      problems.preemptionProtocol = `machine ${m.id}: changeover at the end of the timeline is never followed by production`;
    }
  }

  add('order-single-compatible-machine', flags.singleCompatibleMachine, problems.singleCompatibleMachine);
  add('release-respected', flags.releaseRespected, problems.releaseRespected);
  add('production-within-shifts', flags.withinShifts, problems.withinShifts);

  let durationOk = true;
  let durationProblem = '';
  for (let i = 0; i < N; i++) {
    if (remaining[i] !== 0) {
      durationOk = false;
      durationProblem = `order ${inst.orders[i].id}: ${remaining[i]} of ${inst.orders[i].duration} slot(s) unscheduled`;
      break;
    }
  }
  add('all-orders-complete-exact-duration', durationOk, durationProblem);

  let quotaOk = true;
  let quotaProblem = '';
  inst.shifts.forEach((s, si) => {
    for (const [fam, used] of usage[si]) {
      const cap = s.quotas[fam] ?? 0;
      if (used > cap) {
        quotaOk = false;
        quotaProblem = `shift ${s.id} family ${fam}: used ${used} exceeds capacity ${cap}`;
      }
    }
  });
  add('shift-quotas-respected', quotaOk, quotaProblem);

  add('preemption-protocol', flags.preemptionProtocol, problems.preemptionProtocol);
  add('interruption-only-by-preemption', flags.interruptionOnlyByPreemption, problems.interruptionOnlyByPreemption);
  add('preemption-limit-two', flags.preemptionLimit, problems.preemptionLimit);

  // ---- cross-check reported aggregates ----------------------------------
  let quotaTableOk = Array.isArray(sol.quotaUsage);
  let quotaTableProblem = '';
  if (quotaTableOk) {
    const expected = [];
    inst.shifts.forEach((s, si) => {
      const fams = new Set([...Object.keys(s.quotas), ...usage[si].keys()]);
      for (const family of fams) {
        expected.push({ shift: s.id, family, used: usage[si].get(family) ?? 0, capacity: s.quotas[family] ?? 0 });
      }
    });
    const key = (e) => `${e.shift}|${e.family}`;
    const reported = new Map(sol.quotaUsage.map((e) => [key(e), e]));
    for (const e of expected) {
      const r = reported.get(key(e));
      if (!r || r.used !== e.used || r.capacity !== e.capacity) {
        quotaTableOk = false;
        quotaTableProblem = `quotaUsage entry for ${key(e)} is missing or wrong (expected used=${e.used} capacity=${e.capacity})`;
        break;
      }
      reported.delete(key(e));
    }
    if (quotaTableOk && reported.size > 0) {
      quotaTableOk = false;
      quotaTableProblem = `quotaUsage contains unexpected entries: ${[...reported.keys()].join(', ')}`;
    }
  }
  add('quota-usage-table-accurate', quotaTableOk, quotaTableProblem);

  let ordersOk = Array.isArray(sol.orders);
  let ordersProblem = '';
  let totalTardiness = 0;
  if (ordersOk) {
    const reported = new Map(sol.orders.map((o) => [o.id, o]));
    for (let i = 0; i < N; i++) {
      const o = inst.orders[i];
      const r = reported.get(o.id);
      const tard = Math.max(0, completion[i] - o.deadline);
      totalTardiness += tard;
      if (!r) { ordersOk = false; ordersProblem = `order ${o.id} missing from orders section`; break; }
      const expectedSegments = (slicesByMachine.get(orderMachine[i]) ?? [])
        .filter((s) => s.order === o.id).map((s) => ({ start: s.start, end: s.end }));
      const segmentsOk = JSON.stringify(r.segments) === JSON.stringify(expectedSegments);
      if (r.machine !== orderMachine[i] || !segmentsOk || r.completion !== completion[i] ||
          r.tardiness !== tard || r.preemptions !== preemptCount[i]) {
        ordersOk = false;
        ordersProblem = `order ${o.id}: reported machine/segments/completion/tardiness/preemptions do not match the slices`;
        break;
      }
    }
  }
  add('order-records-accurate', ordersOk, ordersProblem);
  add('total-tardiness-accurate',
    sol.objective && sol.objective.totalTardiness === totalTardiness,
    `reported=${sol.objective && sol.objective.totalTardiness} recomputed=${totalTardiness}`);

  let preemptOk = sol.preemptions && typeof sol.preemptions === 'object';
  let preemptProblem = '';
  if (preemptOk) {
    const events = [...derivedEvents].sort((a, b) =>
      (a.slot - b.slot) || (a.machine < b.machine ? -1 : 1));
    const reported = [...(sol.preemptions.events ?? [])].sort((a, b) =>
      (a.slot - b.slot) || (a.machine < b.machine ? -1 : 1));
    if (JSON.stringify(events) !== JSON.stringify(reported)) {
      preemptOk = false;
      preemptProblem = 'preemptions.events do not match the changeover slices';
    } else if (sol.preemptions.total !== derivedEvents.length) {
      preemptOk = false;
      preemptProblem = `preemptions.total=${sol.preemptions.total} but ${derivedEvents.length} changeover slice(s) exist`;
    } else {
      for (let i = 0; i < N; i++) {
        const id = inst.orders[i].id;
        const reportedCount = sol.preemptions.byOrder?.[id] ?? 0;
        if (reportedCount !== preemptCount[i]) {
          preemptOk = false;
          preemptProblem = `preemptions.byOrder.${id}=${reportedCount} but ${preemptCount[i]} preemption(s) found`;
          break;
        }
      }
    }
  }
  add('preemption-records-accurate', preemptOk, preemptProblem);

  return finish();
}
