import type { ScheduleInput, ScheduleResult, SlotDelivery, SlotReport } from "./types.js";

interface Entry {
  shortage: number;
  assign: number[];
}

function assignLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? -1;
    const y = b[i] ?? -1;
    if (x !== y) return x < y;
  }
  return false;
}

function betterEntry(a: Entry, b: Entry): boolean {
  if (a.shortage !== b.shortage) return a.shortage < b.shortage;
  return assignLess(a.assign, b.assign);
}

function buildReport(input: ScheduleInput, assign: number[]): SlotReport[] {
  const n = input.quantities.length;
  const deliveries: SlotDelivery[][] = input.slots.map(() => []);
  for (let i = 0; i < n; i++) {
    const slot = assign[i] ?? -1;
    const qty = input.quantities[i] ?? 0;
    if (slot >= 0 && qty > 0) {
      const bucket = deliveries[slot];
      if (bucket !== undefined) bucket.push({ supplier: i, quantity: qty });
    }
  }
  let cumArrival = 0;
  let cumDemand = 0;
  return input.slots.map((slot, t) => {
    const list = deliveries[t] ?? [];
    const load = list.reduce((sum, d) => sum + d.quantity, 0);
    cumArrival += load;
    cumDemand += slot.demand;
    return {
      slot: t,
      capacity: slot.capacity,
      demand: slot.demand,
      deliveries: list,
      load,
      cumArrival,
      cumDemand,
      shortage: Math.max(0, cumDemand - cumArrival),
    };
  });
}

function toResult(feasible: boolean, assign: number[], input: ScheduleInput): ScheduleResult {
  const slots = buildReport(input, assign);
  const totalShortage = slots.reduce((sum, s) => sum + s.shortage, 0);
  return { feasible, assignment: assign, totalShortage, slots };
}

export function solveSchedule(input: ScheduleInput): ScheduleResult {
  const n = input.quantities.length;
  const slotCount = input.slots.length;
  const maskCount = 1 << n;
  const maskSum = new Array<number>(maskCount).fill(0);
  for (let mask = 1; mask < maskCount; mask++) {
    const low = mask & -mask;
    const bit = 31 - Math.clz32(low);
    maskSum[mask] = (maskSum[mask ^ low] ?? 0) + (input.quantities[bit] ?? 0);
  }
  let fullMask = 0;
  for (let i = 0; i < n; i++) {
    if ((input.quantities[i] ?? 0) > 0) fullMask |= 1 << i;
  }
  const cumDemand = new Array<number>(slotCount).fill(0);
  let acc = 0;
  for (let t = 0; t < slotCount; t++) {
    acc += input.slots[t]?.demand ?? 0;
    cumDemand[t] = acc;
  }

  let layer = new Map<number, Entry>();
  layer.set(0, { shortage: 0, assign: new Array<number>(n).fill(-1) });

  for (let t = 0; t < slotCount; t++) {
    const capacity = input.slots[t]?.capacity ?? 0;
    const need = cumDemand[t] ?? 0;
    const next = new Map<number, Entry>();
    const consider = (mask: number, cand: Entry): void => {
      const cur = next.get(mask);
      if (cur === undefined || betterEntry(cand, cur)) next.set(mask, cand);
    };
    for (const [mask, entry] of layer) {
      const remaining = fullMask & ~mask;
      for (let sub = remaining; ; sub = (sub - 1) & remaining) {
        if ((maskSum[sub] ?? 0) <= capacity) {
          const newMask = mask | sub;
          const add = Math.max(0, need - (maskSum[newMask] ?? 0));
          const assign = entry.assign.slice();
          for (let m = sub; m !== 0; m &= m - 1) {
            const low = m & -m;
            assign[31 - Math.clz32(low)] = t;
          }
          consider(newMask, { shortage: entry.shortage + add, assign });
        }
        if (sub === 0) break;
      }
    }
    layer = next;
  }

  const best = layer.get(fullMask);
  if (best === undefined) {
    return toResult(false, new Array<number>(n).fill(-1), input);
  }
  return toResult(true, best.assign, input);
}

export function bruteForceSchedule(input: ScheduleInput): ScheduleResult {
  const n = input.quantities.length;
  const slotCount = input.slots.length;
  const assign = new Array<number>(n).fill(-1);
  const loads = new Array<number>(slotCount).fill(0);
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    if ((input.quantities[i] ?? 0) > 0) order.push(i);
  }
  const holder: { best: Entry | null } = { best: null };

  const rec = (k: number): void => {
    if (k === order.length) {
      const report = buildReport(input, assign);
      const shortage = report.reduce((sum, s) => sum + s.shortage, 0);
      const cand = { shortage, assign: assign.slice() };
      if (holder.best === null || betterEntry(cand, holder.best)) holder.best = cand;
      return;
    }
    const i = order[k];
    if (i === undefined) return;
    const qty = input.quantities[i] ?? 0;
    for (let t = 0; t < slotCount; t++) {
      const cap = input.slots[t]?.capacity ?? 0;
      if ((loads[t] ?? 0) + qty > cap) continue;
      loads[t] = (loads[t] ?? 0) + qty;
      assign[i] = t;
      rec(k + 1);
      assign[i] = -1;
      loads[t] = (loads[t] ?? 0) - qty;
    }
  };
  rec(0);

  const best = holder.best;
  if (best === null) {
    return toResult(false, new Array<number>(n).fill(-1), input);
  }
  return toResult(true, best.assign, input);
}

export function bruteForceSize(input: ScheduleInput): number {
  let positive = 0;
  for (const q of input.quantities) {
    if (q > 0) positive++;
  }
  return Math.pow(input.slots.length, positive);
}
