export interface EdgeSpec {
  from: string;
  to: string;
  energy: number;
}

export interface VehicleSpec {
  id: string;
  path: string[];
  initialEnergy: number;
  batteryCapacity: number;
  chargeStops?: string[];
  auxDrainPerTick?: number;
}

export interface StationSpec {
  node: string;
  capacity: number;
  chargePerTick: number;
  windows: Array<[number, number]>;
}

export interface SimConfig {
  edges: EdgeSpec[];
  vehicles: VehicleSpec[];
  stations: StationSpec[];
  maxTicks: number;
}

export type LedgerKind = "move" | "charge" | "aux-drain";

export interface LedgerEntry {
  tick: number;
  vehicleId: string;
  kind: LedgerKind;
  delta: number;
  before: number;
  after: number;
}

export type VehicleStatus = "ready" | "queued" | "done" | "stranded";

export interface VehicleSnapshot {
  id: string;
  nodeIndex: number;
  node: string;
  energy: number;
  status: VehicleStatus;
}

export interface StationSnapshot {
  node: string;
  queue: string[];
  granted: string[];
  open: boolean;
}

export interface TickSnapshot {
  tick: number;
  vehicles: VehicleSnapshot[];
  stations: StationSnapshot[];
}

export interface SimResult {
  config: SimConfig;
  snapshots: TickSnapshot[];
  ledger: LedgerEntry[];
}

export interface VerificationReport {
  ok: boolean;
  errors: string[];
}
