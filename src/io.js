"use strict";

const { ExitError } = require("./errors");

const KNOWN_CURRENCIES = new Set(["CNY", "USD", "EUR", "JPY", "GBP", "HKD"]);

function normalizePolicy(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ExitError("policy.json must be a JSON object", 1);
  }
  if (!KNOWN_CURRENCIES.has(raw.currency)) {
    throw new ExitError(`unknown budget currency: ${String(raw.currency)}`, 20);
  }
  if (typeof raw.shiftBudget !== "number" || !Number.isFinite(raw.shiftBudget) || raw.shiftBudget < 0) {
    throw new ExitError("policy.shiftBudget must be a non-negative number", 1);
  }
  const categories = raw.categories || {};
  if (categories === null || typeof categories !== "object" || Array.isArray(categories)) {
    throw new ExitError("policy.categories must be an object", 1);
  }
  return {
    currency: raw.currency,
    shiftBudget: raw.shiftBudget,
    categories,
    reworkableLevels: Array.isArray(raw.reworkableLevels) ? raw.reworkableLevels : ["minor", "major"],
    blacklist: Array.isArray(raw.blacklist) ? raw.blacklist : [],
    concessionThreshold: typeof raw.concessionThreshold === "number" ? raw.concessionThreshold : Infinity,
    stockUseCap: typeof raw.stockUseCap === "number" ? raw.stockUseCap : Infinity,
  };
}

function normalizeStock(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ExitError("stock.json must be a JSON object", 1);
  }
  const stock = {};
  for (const [product, qty] of Object.entries(raw)) {
    if (typeof qty !== "number" || !Number.isFinite(qty)) {
      throw new ExitError(`stock for product ${product} must be a number`, 1);
    }
    if (qty < 0) {
      throw new ExitError(`negative stock for product ${product}: ${qty}`, 19);
    }
    stock[product] = qty;
  }
  return stock;
}

function parseDefectsJsonl(text, policy) {
  const entries = [];
  const seenIds = new Set();
  const lines = text.split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const trimmed = lines[idx].trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new ExitError(`invalid JSON on line ${idx + 1}`, 1);
    }
    if (obj !== null && typeof obj === "object" && obj.type === "cancel") {
      if (typeof obj.defectId !== "string") {
        throw new ExitError(`cancel event on line ${idx + 1} is missing defectId`, 1);
      }
      entries.push({ kind: "cancel", defectId: obj.defectId, reason: obj.reason || "" });
      continue;
    }
    if (obj !== null && typeof obj === "object" && obj.type === "budgetCorrection") {
      if (typeof obj.amount !== "number" || !Number.isFinite(obj.amount)) {
        throw new ExitError(`budgetCorrection on line ${idx + 1} has invalid amount`, 1);
      }
      const currency = obj.currency === undefined ? policy.currency : obj.currency;
      if (!KNOWN_CURRENCIES.has(currency)) {
        throw new ExitError(`unknown budget currency: ${String(currency)}`, 20);
      }
      if (currency !== policy.currency) {
        throw new ExitError(
          `budgetCorrection currency ${currency} does not match policy currency ${policy.currency}`,
          1
        );
      }
      entries.push({ kind: "budgetCorrection", amount: obj.amount, reason: obj.reason || "" });
      continue;
    }
    if (obj === null || typeof obj !== "object" || typeof obj.id !== "string") {
      throw new ExitError(`defect on line ${idx + 1} is missing a string id`, 1);
    }
    if (seenIds.has(obj.id)) {
      throw new ExitError(`duplicate defect id: ${obj.id}`, 21);
    }
    seenIds.add(obj.id);
    if (typeof obj.product !== "string") {
      throw new ExitError(`defect ${obj.id} is missing a product`, 1);
    }
    if (typeof obj.amount !== "number" || !Number.isFinite(obj.amount) || obj.amount < 0) {
      throw new ExitError(`defect ${obj.id} has invalid amount`, 1);
    }
    entries.push({
      kind: "defect",
      defect: {
        id: obj.id,
        product: obj.product,
        customer: typeof obj.customer === "string" ? obj.customer : "",
        amount: obj.amount,
        level: typeof obj.level === "string" ? obj.level : null,
        reworkCost: typeof obj.reworkCost === "number" ? obj.reworkCost : null,
      },
    });
  }
  return entries;
}

module.exports = { KNOWN_CURRENCIES, normalizePolicy, normalizeStock, parseDefectsJsonl };
