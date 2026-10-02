export const HORIZON_MS = 8 * 60 * 60 * 1000; // 8h replanning horizon
export const WATERMARK_DELAY_MS = 2 * 60 * 1000; // watermark = max event time - 2min
export const WINDOW_MS = 60 * 60 * 1000; // 1h emission windows over the horizon
export const CHANGEOVER_MS = 10 * 60 * 1000; // mold changeover duration
export const UNIT_PROCESS_MS = 60 * 1000; // 1 minute of machine time per unit
export const CHANGEOVER_ENERGY_TENTHS = 50; // 5.0 kWh per mold changeover
export const UNIT_ENERGY_TENTHS = 1; // 0.1 kWh per unit produced
export const MAX_ENUM_JOBS = 8; // exhaustive permutation search up to this many jobs
