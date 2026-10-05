export { Rational, rat } from "./rational.js";
export { PiecewiseLinear, mergeCuts } from "./piecewise.js";
export type { Breakpoint } from "./piecewise.js";
export { simulate } from "./thermostat.js";
export type {
  ThermostatConfig,
  HeaterAction,
  SwitchReason,
  SwitchEvent,
  TrajectorySegment,
  SimulationResult,
} from "./thermostat.js";
export { verify, formatReport } from "./verify.js";
export type { VerificationOptions, CheckResult, VerificationReport } from "./verify.js";
