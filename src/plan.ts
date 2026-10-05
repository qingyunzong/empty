// Assemble a fresh-horizon planning problem (no published orders) per warehouse.

import { WarehouseInput, StreamName } from "./model";
import { SolveInput, StreamSpec, ArrivalSlot } from "./core";

export function streamsOf(wh: WarehouseInput): StreamSpec[] {
  const streams: StreamSpec[] = [
    { name: "normal", lead: wh.leadTime, fixedCost: wh.fixedOrderCost, unitCost: wh.unitCost ?? 0 },
  ];
  if (wh.expedite) {
    streams.push({
      name: "expedited",
      lead: wh.expedite.leadTime,
      fixedCost: wh.expedite.fixedCost,
      unitCost: wh.expedite.unitCost ?? 0,
    });
  }
  return streams;
}

export function streamIndexOf(wh: WarehouseInput, name: StreamName | undefined): number {
  if (name === "expedited") {
    if (!wh.expedite) throw new Error(`${wh.id}: no expedite stream configured`);
    return 1;
  }
  return 0;
}

export function buildPlanInput(wh: WarehouseInput, horizon: number): SolveInput {
  const streams = streamsOf(wh);
  const slots: ArrivalSlot[][] = [];
  for (let t = 0; t < horizon; t++) {
    const row: ArrivalSlot[] = [];
    for (let s = 0; s < streams.length; s++) {
      let committed = 0;
      for (const p of wh.pipeline ?? []) {
        if (p.arrivalDay === t && streamIndexOf(wh, p.stream) === s) committed += p.qty;
      }
      if (t < streams[s].lead) {
        // too early to place a fresh order arriving this day: pipeline only
        row.push({ min: committed, max: committed, counted: false, devBase: null });
      } else {
        row.push({ min: 0, max: wh.capacity, counted: true, devBase: null });
      }
    }
    slots.push(row);
  }
  return {
    capacity: wh.capacity,
    initialInventory: wh.initialInventory,
    demand: wh.demand.slice(),
    holdingCost: wh.holdingCost,
    streams,
    slots,
  };
}
