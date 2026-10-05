export type {
  ChargerSpec,
  ChargerWindow,
  ChargeStopSpec,
  EnergyEvent,
  EnergyEventType,
  LegSpec,
  SimConfig,
  TickSnapshot,
  VehicleSnapshot,
  VehicleSpec,
  VehicleState,
} from "./types.js";
export { Simulation, legTickCost } from "./simulation.js";
export type { SimSnapshot } from "./simulation.js";
export { auditReplay, computeLedger, replayBatteries } from "./ledger.js";
export type { AuditResult, VehicleLedger } from "./ledger.js";
