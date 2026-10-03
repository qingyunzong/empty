import { readFileSync } from 'node:fs';
import { ExitError, EXIT } from './errors.js';

export const ZONE_KINDS = new Set(['normal', 'restricted', 'coldchain', 'charging']);

export function loadMap(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ExitError(2, `cannot read map ${path}: ${err.message}`);
  }
  return indexMap(raw);
}

export function checkCoord(map, x, y, what) {
  if (
    typeof x !== 'number' || typeof y !== 'number' ||
    !Number.isFinite(x) || !Number.isFinite(y) ||
    x < 0 || y < 0 || x >= map.width || y >= map.height
  ) {
    throw new ExitError(
      EXIT.OUT_OF_BOUNDS,
      `${what} coordinate (${x},${y}) out of bounds ${map.width}x${map.height}`,
    );
  }
}

export function indexMap(map) {
  if (!map || typeof map.width !== 'number' || typeof map.height !== 'number') {
    throw new ExitError(2, 'map requires numeric width/height');
  }
  const zones = new Map();
  const aisles = new Map();
  const shelves = new Map();
  for (const zone of map.zones ?? []) {
    if (!zone.id || zones.has(zone.id)) throw new ExitError(2, `bad or duplicate zone id ${zone.id}`);
    if (!ZONE_KINDS.has(zone.kind)) throw new ExitError(2, `zone ${zone.id}: bad kind ${zone.kind}`);
    const z = { id: zone.id, kind: zone.kind, aisles: [] };
    zones.set(z.id, z);
    for (const aisle of zone.aisles ?? []) {
      if (!aisle.id || aisles.has(aisle.id)) throw new ExitError(2, `bad or duplicate aisle id ${aisle.id}`);
      const a = { id: aisle.id, zone: z, shelves: [] };
      aisles.set(a.id, a);
      z.aisles.push(a);
      for (const shelf of aisle.shelves ?? []) {
        if (!shelf.id || shelves.has(shelf.id)) throw new ExitError(2, `bad or duplicate shelf id ${shelf.id}`);
        checkCoord(map, shelf.x, shelf.y, `shelf ${shelf.id}`);
        const s = { id: shelf.id, x: shelf.x, y: shelf.y, aisle: a, zone: z };
        shelves.set(s.id, s);
        a.shelves.push(s);
      }
    }
  }
  return { map, zones, aisles, shelves };
}

export function resolveTarget(idx, target) {
  if (!target || typeof target !== 'object') throw new ExitError(2, 'task target missing');
  const zone = idx.zones.get(target.zone);
  if (!zone) throw new ExitError(2, `unknown zone ${target.zone}`);
  let aisle = null;
  let shelf = null;
  if (target.shelf != null) {
    shelf = idx.shelves.get(target.shelf);
    if (!shelf || shelf.zone.id !== zone.id) throw new ExitError(2, `unknown shelf ${target.shelf} in zone ${zone.id}`);
    if (target.aisle != null && target.aisle !== shelf.aisle.id) {
      throw new ExitError(2, `shelf ${target.shelf} not in aisle ${target.aisle}`);
    }
    aisle = shelf.aisle;
  } else if (target.aisle != null) {
    aisle = idx.aisles.get(target.aisle);
    if (!aisle || aisle.zone.id !== zone.id) throw new ExitError(2, `unknown aisle ${target.aisle} in zone ${zone.id}`);
  }
  if (target.x !== undefined || target.y !== undefined) {
    checkCoord(idx.map, target.x, target.y, 'task target');
  }
  return { zone, aisle, shelf };
}
