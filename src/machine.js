export const STATES = Object.freeze(['idle', 'cutting', 'worn', 'locked']);

export const LEGAL_TRANSITIONS = Object.freeze({
  idle: ['cutting', 'locked'],
  cutting: ['idle', 'worn', 'locked'],
  worn: ['locked'],
  locked: [],
});

export function deriveStatus(usage, limits) {
  if (usage <= 0) return 'idle';
  const finite = limits.filter((l) => l !== undefined && Number.isFinite(l));
  if (finite.some((l) => usage > l)) return 'locked';
  if (finite.some((l) => usage === l)) return 'worn';
  return 'cutting';
}
