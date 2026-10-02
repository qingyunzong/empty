// Parsing and validation of JSONL planning input.
// Any violation raises InputError -> CLI exit 2 with {code, at} on stderr.

export class InputError extends Error {
  constructor(code, at) {
    super(`${code} at ${at}`);
    this.code = code;
    this.at = at;
  }
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isPosInt(v) {
  return Number.isInteger(v) && v >= 1;
}

function isNonNegInt(v) {
  return Number.isInteger(v) && v >= 0;
}

function isId(v) {
  return typeof v === "string" && v.length > 0;
}

export function validateOrder(raw, at) {
  if (!isObj(raw)) throw new InputError("SCHEMA", at);
  if (!isId(raw.id)) throw new InputError("SCHEMA", `${at}.id`);
  if (!isId(raw.mold)) throw new InputError("SCHEMA", `${at}.mold`);
  if (!isPosInt(raw.qty)) throw new InputError("SCHEMA", `${at}.qty`);
  if (!isNonNegInt(raw.due)) throw new InputError("SCHEMA", `${at}.due`);
  if (!isId(raw.person)) throw new InputError("SCHEMA", `${at}.person`);
  if (raw.committed !== undefined && typeof raw.committed !== "boolean")
    throw new InputError("SCHEMA", `${at}.committed`);
  return {
    id: raw.id,
    mold: raw.mold,
    qty: raw.qty,
    due: raw.due,
    person: raw.person,
    committed: raw.committed === true,
  };
}

// Parse a JSONL document of typed records into a scheduling instance.
export function parseInput(text, name) {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    const at = `${name}:${i + 1}`;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new InputError("PARSE_ERROR", at);
    }
    if (!isObj(rec) || !isId(rec.type)) throw new InputError("SCHEMA", at);
    records.push({ rec, at });
  }

  const machines = new Set();
  const molds = {};
  const setups = {};
  const orders = {};

  for (const { rec, at } of records) {
    switch (rec.type) {
      case "machine": {
        if (!isId(rec.id)) throw new InputError("SCHEMA", `${at}.id`);
        if (machines.has(rec.id)) throw new InputError("DUPLICATE", at);
        machines.add(rec.id);
        break;
      }
      case "mold": {
        if (!isId(rec.id)) throw new InputError("SCHEMA", `${at}.id`);
        if (!isPosInt(rec.cycle)) throw new InputError("SCHEMA", `${at}.cycle`);
        if (molds[rec.id]) throw new InputError("DUPLICATE", at);
        molds[rec.id] = { id: rec.id, cycle: rec.cycle };
        break;
      }
      case "setup": {
        if (!isId(rec.from) || !isId(rec.to)) throw new InputError("SCHEMA", at);
        if (!isNonNegInt(rec.time)) throw new InputError("SCHEMA", `${at}.time`);
        (setups[rec.from] ??= {})[rec.to] = rec.time;
        break;
      }
      case "order": {
        const order = validateOrder(rec, at);
        if (orders[order.id]) throw new InputError("DUPLICATE", at);
        orders[order.id] = order;
        break;
      }
      default:
        throw new InputError("SCHEMA", at);
    }
  }

  if (machines.size === 0) throw new InputError("NO_MACHINE", name);

  // Unknown references are invalid input (exit 2), never "infeasible".
  for (const { rec, at } of records) {
    if (rec.type === "order" && !molds[rec.mold])
      throw new InputError("UNKNOWN_MOLD", `${at} (${rec.id}.mold=${rec.mold})`);
    if (rec.type === "setup") {
      if (!molds[rec.from]) throw new InputError("UNKNOWN_MOLD", `${at} (from=${rec.from})`);
      if (!molds[rec.to]) throw new InputError("UNKNOWN_MOLD", `${at} (to=${rec.to})`);
    }
  }

  for (const order of Object.values(orders)) {
    order.proc = order.qty * molds[order.mold].cycle;
  }

  return {
    machines: [...machines].sort(),
    molds,
    setups,
    orders,
    orderIds: Object.keys(orders).sort(),
  };
}
