/** A directed leg of a vehicle's fixed path. */
export interface LegSpec {
  /** Destination node id of this leg. */
  to: string;
  /** Travel time in whole ticks (>= 1). */
  ticks: number;
  /**
   * Total integer energy consumed across the leg. It is spread over the
   * leg's ticks as floor(energy / ticks) per tick, with the remainder
   * distributed one extra unit over the first (energy % ticks) ticks, so the
   * per-tick costs are integers that sum exactly to `energy`.
   */
  energy: number;
}

/** A planned charging stop: charge at `node` until battery reaches target. */
export interface ChargeStopSpec {
  node: string;
  targetBattery: number;
}

export interface VehicleSpec {
  id: string;
  /** Node where the vehicle sits at tick 0. */
  startNode: string;
  /** Fixed path: ordered legs, traversed in sequence. */
  path: LegSpec[];
  batteryCapacity: number;
  initialBattery: number;
  /** Planned charging stops (matched by node id). */
  chargePlan?: ChargeStopSpec[];
  /**
   * Auxiliary energy drained per tick while queued for a charger
   * ("waiting may consume auxiliary energy"). Defaults to 0. The drain is
   * clamped so the battery never goes below 0.
   */
  auxDrainPerTick?: number;
}

/** Half-open tick window [start, end) during which a charger operates. */
export interface ChargerWindow {
  start: number;
  end: number;
}

export interface ChargerSpec {
  id: string;
  /** Node where the charger is installed. */
  node: string;
  /** Maximum number of vehicles charging concurrently (occupancy capacity). */
  capacity: number;
  /** Integer energy granted per tick to each occupying vehicle. */
  ratePerTick: number;
  /** Operating windows; outside them no energy is granted. */
  windows: ChargerWindow[];
}

export interface SimConfig {
  vehicles: VehicleSpec[];
  chargers: ChargerSpec[];
  /** Hard upper bound on simulated ticks. */
  maxTicks: number;
  /** Record a snapshot after every tick for replay verification. */
  recordHistory?: boolean;
}

export type VehicleState =
  | "moving"
  | "waiting-charge"
  | "charging"
  | "stalled"
  | "idle"
  | "done";

export type EnergyEventType = "drive" | "aux" | "charge";

/** A single integer energy movement for one vehicle in one tick. */
export interface EnergyEvent {
  tick: number;
  vehicleId: string;
  type: EnergyEventType;
  amount: number;
}

export interface VehicleSnapshot {
  id: string;
  node: string;
  state: VehicleState;
  battery: number;
  legIndex: number;
  legProgress: number;
}

/** Public, deep-cloned view of the world at the start of tick `tick`. */
export interface TickSnapshot {
  tick: number;
  vehicles: VehicleSnapshot[];
}
