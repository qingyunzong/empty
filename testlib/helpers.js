export const T0 = 1_700_000_000_000;
export const MIN = 60_000;

export function temp(id, eventTs, zone, c, extra = {}) {
  return { type: 'temp', id, eventTs, zone, c, ...extra };
}
export function door(id, eventTs, zone, open, extra = {}) {
  return { type: 'door', id, eventTs, zone, open, ...extra };
}
export function ship(id, eventTs, lot, zone, start, end, extra = {}) {
  return { type: 'ship', id, eventTs, lot, zone, start, end, ...extra };
}
export function repair(id, eventTs, sensor, ok, extra = {}) {
  return { type: 'repair', id, eventTs, sensor, ok, ...extra };
}
export function retract(eventTs, kind, id) {
  return { type: 'retract', eventTs, kind, id };
}
