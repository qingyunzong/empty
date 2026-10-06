export interface Tier {
  upTo: number;
  unitPrice: number;
}

export interface Supplier {
  name: string;
  minQty: number;
  maxQty: number;
  tiers: Tier[];
}

export interface ProcurementInput {
  demand: number;
  maxTotal: number;
  suppliers: Supplier[];
  mutex?: [number, number][];
  depends?: [number, number][];
}

export interface Slot {
  capacity: number;
  demand: number;
}

export interface ScheduleInput {
  quantities: number[];
  slots: Slot[];
}

export interface ProcurementResult {
  feasible: boolean;
  quantities: number[];
  totalQuantity: number;
  totalCost: number;
  overPurchase: number;
}

export interface SlotDelivery {
  supplier: number;
  quantity: number;
}

export interface SlotReport {
  slot: number;
  capacity: number;
  demand: number;
  deliveries: SlotDelivery[];
  load: number;
  cumArrival: number;
  cumDemand: number;
  shortage: number;
}

export interface ScheduleResult {
  feasible: boolean;
  assignment: number[];
  totalShortage: number;
  slots: SlotReport[];
}
