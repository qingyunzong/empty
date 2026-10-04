import type { Supplier, Tier } from "./types";

export const MAX_SUPPLIERS = 6;
export const DEFAULT_DEMAND = 200;

function fail(message: string): never {
  throw new Error(`invalid supplier config: ${message}`);
}

function requireInt(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    fail(`${field} must be an integer >= ${min}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseSuppliers(raw: unknown): Supplier[] {
  const list = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === "object" && Array.isArray((raw as { suppliers?: unknown }).suppliers)
      ? (raw as { suppliers: unknown[] }).suppliers
      : fail("expected a JSON array or an object with a \"suppliers\" array");
  if (list.length < 1) fail("at least 1 supplier is required");
  if (list.length > MAX_SUPPLIERS) fail(`at most ${MAX_SUPPLIERS} suppliers, got ${list.length}`);

  return list.map((item, index): Supplier => {
    if (item === null || typeof item !== "object") fail(`suppliers[${index}] must be an object`);
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id.length > 0 ? o.id : fail(`suppliers[${index}].id must be a non-empty string`);
    const moq = requireInt(o.moq ?? 1, `suppliers[${index}].moq`, 1);

    if (!Array.isArray(o.tiers) || o.tiers.length < 1) fail(`suppliers[${index}].tiers must be a non-empty array`);
    const tiers: Tier[] = o.tiers.map((t, ti): Tier => {
      if (t === null || typeof t !== "object") fail(`suppliers[${index}].tiers[${ti}] must be an object`);
      const tier = t as Record<string, unknown>;
      return {
        minQty: requireInt(tier.minQty, `suppliers[${index}].tiers[${ti}].minQty`, 1),
        unitPriceCents: requireInt(tier.unitPriceCents, `suppliers[${index}].tiers[${ti}].unitPriceCents`, 0),
      };
    });
    tiers.sort((a, b) => a.minQty - b.minQty);
    for (let ti = 1; ti < tiers.length; ti++) {
      if (tiers[ti]!.minQty === tiers[ti - 1]!.minQty) fail(`suppliers[${index}] has duplicate tier minQty=${tiers[ti]!.minQty}`);
    }
    if (tiers[0]!.minQty > moq) fail(`suppliers[${index}] first tier minQty=${tiers[0]!.minQty} exceeds moq=${moq}`);

    if (o.shipping === null || typeof o.shipping !== "object") fail(`suppliers[${index}].shipping must be an object`);
    const shipping = o.shipping as Record<string, unknown>;
    return {
      id,
      moq,
      tiers,
      shipping: {
        freeAboveCents: requireInt(shipping.freeAboveCents, `suppliers[${index}].shipping.freeAboveCents`, 0),
        feeCents: requireInt(shipping.feeCents, `suppliers[${index}].shipping.feeCents`, 0),
      },
    };
  });
}
