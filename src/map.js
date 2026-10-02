import { ExitError, EXIT } from './errors.js';

// Index the warehouse map: zone -> aisle -> shelf, with coordinate bounds
// validation. Any shelf outside bounds is a hard error (exit 23).
export function indexMap(map) {
  const { width, height } = map.bounds ?? {};
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new ExitError(EXIT.OUT_OF_BOUNDS, 'map.bounds must be positive integers');
  }
  const zones = new Map();
  const aisles = new Map();
  const shelves = new Map();
  for (const zone of map.zones ?? []) {
    zones.set(zone.id, { ...zone, kind: zone.kind ?? 'normal' });
    for (const aisle of zone.aisles ?? []) {
      aisles.set(aisle.id, { ...aisle, zoneId: zone.id });
      for (const shelf of aisle.shelves ?? []) {
        checkBounds(shelf.x, shelf.y, width, height, `shelf ${shelf.id}`);
        shelves.set(shelf.id, { ...shelf, aisleId: aisle.id, zoneId: zone.id });
      }
    }
  }
  return { map, zones, aisles, shelves, width, height };
}

function checkBounds(x, y, width, height, what) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) {
    throw new ExitError(
      EXIT.OUT_OF_BOUNDS,
      `${what} coordinate (${x},${y}) out of bounds ${width}x${height}`,
    );
  }
}

// Resolve a task target to { shelfId?, aisleId?, zoneId }.
// Target forms: {shelf} | {aisle} | {zone} | {x, y}.
// Returns null for unknown named targets; throws exit 23 for bad coordinates.
export function resolveTarget(mapIndex, target) {
  if (target.shelf != null) {
    const shelf = mapIndex.shelves.get(target.shelf);
    if (!shelf) return null;
    return { shelfId: shelf.id, aisleId: shelf.aisleId, zoneId: shelf.zoneId };
  }
  if (target.aisle != null) {
    const aisle = mapIndex.aisles.get(target.aisle);
    if (!aisle) return null;
    return { aisleId: aisle.id, zoneId: aisle.zoneId };
  }
  if (target.zone != null) {
    if (!mapIndex.zones.has(target.zone)) return null;
    return { zoneId: target.zone };
  }
  if (target.x != null || target.y != null) {
    checkBounds(target.x, target.y, mapIndex.width, mapIndex.height, 'task target');
    for (const shelf of mapIndex.shelves.values()) {
      if (shelf.x === target.x && shelf.y === target.y) {
        return { shelfId: shelf.id, aisleId: shelf.aisleId, zoneId: shelf.zoneId };
      }
    }
    return null;
  }
  return null;
}
