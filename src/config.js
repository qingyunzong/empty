export const DEFAULT_CONFIG = {
  channels: 1,
  plateWells: 384,
  wellCapacity: 10,
  ambientTemp: 25,
  cooldownPerDegree: 0.5,
  costPerUnit: 1,
  agingInterval: 10,
  maxTempJump: 60,
  exactThreshold: 8,
};

export function normalizeConfig(overrides = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...overrides };
  const positiveInt = ['channels', 'plateWells', 'agingInterval'];
  const nonNegative = ['wellCapacity', 'cooldownPerDegree', 'costPerUnit', 'maxTempJump', 'exactThreshold'];
  for (const k of positiveInt) {
    if (!Number.isInteger(cfg[k]) || cfg[k] < 1) throw new Error(`config.${k} must be a positive integer`);
  }
  for (const k of nonNegative) {
    if (!Number.isFinite(cfg[k]) || cfg[k] < 0) throw new Error(`config.${k} must be a non-negative number`);
  }
  if (!Number.isFinite(cfg.ambientTemp)) throw new Error('config.ambientTemp must be a number');
  if (cfg.wellCapacity <= 0) throw new Error('config.wellCapacity must be positive');
  return cfg;
}
