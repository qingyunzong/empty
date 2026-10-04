import { GateError, EXIT } from './errors.js';

const PERMISSIONS = new Set(['allow', 'deny', 'inherit']);

function parseHHMM(value, where) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) {
    throw new GateError(`invalid time "${value}" at ${where}`, EXIT.USAGE);
  }
  const [h, m] = value.split(':').map(Number);
  if (h > 23 || m > 59) {
    throw new GateError(`invalid time "${value}" at ${where}`, EXIT.USAGE);
  }
  return h * 60 + m;
}

function checkPermission(value, where) {
  if (!PERMISSIONS.has(value)) {
    throw new GateError(`invalid permission "${value}" at ${where}`, EXIT.USAGE);
  }
}

// Validates the plant configuration and builds lookup indexes.
// Exit-code relevant checks: negative capability -> 6, unknown material -> 7.
export function buildIndex(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new GateError('config must be a JSON object', EXIT.USAGE);
  }
  const rawShifts = config.calendar?.shifts ?? [];
  if (rawShifts.length === 0) {
    throw new GateError('calendar.shifts must be a non-empty array', EXIT.USAGE);
  }
  const shifts = rawShifts.map((s) => {
    if (!s || typeof s.name !== 'string' || s.name === '') {
      throw new GateError('every shift needs a name', EXIT.USAGE);
    }
    const startMin = parseHHMM(s.start, `shift ${s.name}`);
    const endMin = parseHHMM(s.end, `shift ${s.name}`);
    if (startMin === endMin) {
      throw new GateError(`shift ${s.name} has zero length`, EXIT.USAGE);
    }
    return { name: s.name, startMin, endMin, crossesMidnight: endMin < startMin };
  });

  const materials = {};
  for (const [id, spec] of Object.entries(config.materials ?? {})) {
    const stock = spec?.stock;
    if (!Number.isInteger(stock) || stock < 0) {
      throw new GateError(`material ${id}: stock must be a non-negative integer`, EXIT.USAGE);
    }
    materials[id] = { stock };
  }

  const lines = new Map();
  const centers = new Map();
  const orders = new Map();
  for (const [plId, pl] of Object.entries(config.productLines ?? {})) {
    const plPerm = pl.permission ?? 'allow';
    checkPermission(plPerm, `product line ${plId}`);
    lines.set(plId, { id: plId, permission: plPerm });
    for (const [wcId, wc] of Object.entries(pl.workCenters ?? {})) {
      const wcPerm = wc.permission ?? 'inherit';
      checkPermission(wcPerm, `work center ${wcId}`);
      const capabilities = {};
      for (const [cap, n] of Object.entries(wc.capabilities ?? {})) {
        if (typeof n !== 'number' || Number.isNaN(n) || n < 0) {
          throw new GateError(
            `capability ${wcId}/${cap} is negative or not a number`,
            EXIT.NEGATIVE_CAPABILITY,
          );
        }
        capabilities[cap] = n;
      }
      centers.set(wcId, { id: wcId, lineId: plId, permission: wcPerm, capabilities });
      for (const [woId, wo] of Object.entries(wc.orders ?? {})) {
        if (orders.has(woId)) {
          throw new GateError(`duplicate order ${woId}`, EXIT.USAGE);
        }
        const perm = wo.permission ?? 'inherit';
        checkPermission(perm, `order ${woId}`);
        const mats = {};
        for (const [m, q] of Object.entries(wo.materials ?? {})) {
          if (!(m in materials)) {
            throw new GateError(
              `order ${woId} references unknown material ${m}`,
              EXIT.UNKNOWN_MATERIAL,
            );
          }
          if (!Number.isInteger(q) || q <= 0) {
            throw new GateError(`order ${woId}: material ${m} qty must be a positive integer`, EXIT.USAGE);
          }
          mats[m] = q;
        }
        orders.set(woId, {
          id: woId,
          lineId: plId,
          centerId: wcId,
          permission: perm,
          materials: mats,
          capability: wo.capability ?? null,
          durationMin: wo.durationMin ?? 60,
        });
      }
    }
  }
  return { shifts, materials, lines, centers, orders, policy: config.policy ?? {} };
}

// Three-level inheritance: work order -> work center -> product line.
export function effectivePermission(idx, orderId) {
  const order = idx.orders.get(orderId);
  if (!order) return 'deny';
  if (order.permission !== 'inherit') return order.permission;
  const center = idx.centers.get(order.centerId);
  if (center && center.permission !== 'inherit') return center.permission;
  const line = idx.lines.get(order.lineId);
  return line ? line.permission : 'allow';
}
