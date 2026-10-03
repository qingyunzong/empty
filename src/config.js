import { readFileSync } from 'node:fs';
import path from 'node:path';
import { GateError } from './errors.js';

function readJson(dir, name) {
  try {
    return JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') throw new GateError(`missing config file: ${name}`, 1);
    throw new GateError(`invalid JSON in ${name}: ${e.message}`, 1);
  }
}

export function loadConfig(dir) {
  const calendar = readJson(dir, 'calendar.json');
  const capabilities = readJson(dir, 'capabilities.json');
  const materials = readJson(dir, 'materials.json');
  const policy = readJson(dir, 'policy.json');
  const orders = readJson(dir, 'orders.json');

  for (const [wc, shifts] of Object.entries(capabilities)) {
    for (const [shift, mins] of Object.entries(shifts)) {
      if (typeof mins !== 'number' || mins < 0) {
        throw new GateError(`negative capability: ${wc}/${shift} = ${mins}`, 6);
      }
    }
  }
  for (const order of orders) {
    for (const mat of Object.keys(order.materials ?? {})) {
      if (!(mat in materials)) {
        throw new GateError(`unknown material: ${mat} (order ${order.id})`, 7);
      }
    }
  }
  return { calendar, capabilities, materials, policy, orders };
}
