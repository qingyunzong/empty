export const LAYERS = Object.freeze(['order', 'operation', 'segment']);

export function layerKey(layer, ev) {
  switch (layer) {
    case 'order': return ev.order;
    case 'operation': return `${ev.order}/${ev.op}`;
    case 'segment': return `${ev.order}/${ev.op}/${ev.seg}`;
    default: throw new Error(`unknown layer ${layer}`);
  }
}

export class BudgetBook {
  constructor() {
    this.limits = { order: new Map(), operation: new Map(), segment: new Map() };
    this.usage = { order: new Map(), operation: new Map(), segment: new Map() };
  }

  setLimit(layer, key, limit) {
    this.limits[layer].set(key, limit);
  }

  limit(layer, key) {
    return this.limits[layer].get(key);
  }

  addUsage(ev, delta) {
    for (const layer of LAYERS) {
      const key = layerKey(layer, ev);
      this.usage[layer].set(key, (this.usage[layer].get(key) || 0) + delta);
    }
  }

  exceedances(ev) {
    const out = [];
    for (const layer of LAYERS) {
      const key = layerKey(layer, ev);
      const limit = this.limits[layer].get(key);
      const usage = this.usage[layer].get(key) || 0;
      if (limit !== undefined && usage > limit) out.push({ layer, key, usage, limit });
    }
    return out;
  }

  snapshot() {
    const out = {};
    for (const layer of LAYERS) {
      const keys = new Set([...this.limits[layer].keys(), ...this.usage[layer].keys()]);
      out[layer] = {};
      for (const key of [...keys].sort()) {
        out[layer][key] = {
          usage: this.usage[layer].get(key) || 0,
          limit: this.limits[layer].get(key) ?? null,
        };
      }
    }
    return out;
  }
}
