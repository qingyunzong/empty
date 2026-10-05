// Replanning under corrected demand.
//
// Rules:
//  - published orders keep their locked portion (only the unlocked part can
//    be cancelled); pipeline arrivals are fully locked;
//  - objective is lexicographic: first minimize total absolute change to
//    published order quantities, then minimize total money cost;
//  - each warehouse is solved independently (independent capacities).

import { WarehouseInput, PublishedOrder } from "./model";
import { SolveInput, ArrivalSlot, SolveResult, solve, simulate } from "./core";
import { streamsOf, streamIndexOf } from "./plan";

export interface ReplanChange {
  arrivalDay: number;
  stream: string;
  published: number;
  locked: number;
  newQty: number;
  delta: number;
}

export interface NewOrder {
  placeDay: number;
  arrivalDay: number;
  stream: string;
  qty: number;
}

export interface ReplanOutcome {
  input: SolveInput;
  result: SolveResult;
  changes: ReplanChange[];
  newOrders: NewOrder[];
  totalDeviation: number;
  newMoney: number;
  baselineMoney: number | null; // cost of keeping published orders unchanged
  netDifference: number | null; // newMoney - baselineMoney
}

export function buildReplanInput(
  wh: WarehouseInput,
  horizon: number,
  now: number,
  inventoryAtNow: number,
  published: PublishedOrder[],
  lockWindowDays: number
): SolveInput {
  const streams = streamsOf(wh);
  // Pipeline arrivals are already-placed orders: fully locked.
  const effective: Array<PublishedOrder & { locked: number }> = [];
  for (const p of wh.pipeline ?? []) {
    if (p.arrivalDay >= now) {
      effective.push({ arrivalDay: p.arrivalDay, qty: p.qty, stream: p.stream, locked: p.qty });
    }
  }
  for (const p of published) {
    const locked =
      p.lockedQty !== undefined && p.lockedQty >= 0
        ? p.lockedQty
        : p.arrivalDay < now + lockWindowDays
          ? p.qty
          : 0;
    effective.push({ arrivalDay: p.arrivalDay, qty: p.qty, stream: p.stream, locked });
  }

  const T = horizon - now;
  const slots: ArrivalSlot[][] = [];
  for (let lt = 0; lt < T; lt++) {
    const t = now + lt;
    const row: ArrivalSlot[] = [];
    for (let s = 0; s < streams.length; s++) {
      let pubQty = 0;
      let lockedQty = 0;
      for (const p of effective) {
        if (p.arrivalDay === t && streamIndexOf(wh, p.stream) === s) {
          pubQty += p.qty;
          lockedQty += p.locked;
        }
      }
      if (t < now + streams[s].lead) {
        // No fresh order on this stream can arrive this early.
        if (pubQty === 0) {
          row.push({ min: 0, max: 0, counted: false, devBase: null });
        } else {
          row.push({ min: lockedQty, max: wh.capacity, counted: false, devBase: pubQty });
        }
      } else if (pubQty > 0) {
        // Published order arriving here: its fixed cost is already sunk, only
        // the unlocked portion may be cancelled; deviation is tracked.
        row.push({ min: lockedQty, max: wh.capacity, counted: false, devBase: pubQty });
      } else {
        // Fresh order slot.
        row.push({ min: 0, max: wh.capacity, counted: true, devBase: null });
      }
    }
    slots.push(row);
  }
  return {
    capacity: wh.capacity,
    initialInventory: inventoryAtNow,
    demand: wh.demand.slice(now),
    holdingCost: wh.holdingCost,
    streams,
    slots,
  };
}

export function replanWarehouse(
  wh: WarehouseInput,
  horizon: number,
  now: number,
  inventoryAtNow: number,
  published: PublishedOrder[],
  lockWindowDays: number
): ReplanOutcome {
  const input = buildReplanInput(wh, horizon, now, inventoryAtNow, published, lockWindowDays);
  const result = solve(input);

  // Baseline: keep every published order exactly as announced, order nothing new.
  const baselineDecisions = input.slots.map((row) => ({
    qty: row.map((slot) => (slot.devBase !== null ? slot.devBase : slot.min)),
  }));
  const baselineRows = simulate(input, baselineDecisions);
  const baselineMoney =
    baselineRows === null ? null : baselineRows.reduce((a, r) => a + r.money, 0);

  const changes: ReplanChange[] = [];
  const newOrders: NewOrder[] = [];
  if (result.feasible) {
    for (let lt = 0; lt < input.demand.length; lt++) {
      for (let s = 0; s < input.streams.length; s++) {
        const slot = input.slots[lt][s];
        const qty = result.decisions[lt].qty[s];
        const t = now + lt;
        if (slot.devBase !== null) {
          changes.push({
            arrivalDay: t,
            stream: input.streams[s].name,
            published: slot.devBase,
            locked: slot.min,
            newQty: qty,
            delta: qty - slot.devBase,
          });
        } else if (slot.counted && qty > 0) {
          newOrders.push({
            placeDay: t - input.streams[s].lead,
            arrivalDay: t,
            stream: input.streams[s].name,
            qty,
          });
        }
      }
    }
  }
  const newMoney = result.feasible ? result.cost.money : 0;
  return {
    input,
    result,
    changes,
    newOrders,
    totalDeviation: result.feasible ? result.cost.dev : 0,
    newMoney,
    baselineMoney,
    netDifference: result.feasible && baselineMoney !== null ? newMoney - baselineMoney : null,
  };
}
