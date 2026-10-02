export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const isInt = (v) => Number.isInteger(v);

function need(cond, msg) {
  if (!cond) throw new UsageError(msg);
}

export function parseOperation(raw, ctx) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'operation must be an object');
  need(typeof raw.id === 'string' && raw.id.length > 0, 'operation requires a non-empty string id');
  need(
    Array.isArray(raw.machines) && raw.machines.length > 0,
    `op ${raw.id}: machines must be a non-empty array`
  );
  for (const m of raw.machines) {
    need(typeof m === 'string', `op ${raw.id}: machine entries must be strings`);
    need(ctx.machines.includes(m), `op ${raw.id}: unknown machine "${m}"`);
  }
  need(
    isInt(raw.minutes) && raw.minutes > 0,
    `op ${raw.id}: minutes must be a positive integer, got ${JSON.stringify(raw.minutes)}`
  );
  const duration = Math.ceil(raw.minutes / ctx.slotMinutes);
  const fixture = raw.fixture ?? null;
  if (fixture !== null) {
    need(typeof fixture === 'string', `op ${raw.id}: fixture must be a string`);
    need(ctx.fixtures.includes(fixture), `op ${raw.id}: unknown fixture "${fixture}"`);
  }
  const tools = raw.tools ?? [...ctx.toolIds];
  need(Array.isArray(tools), `op ${raw.id}: tools must be an array`);
  need(
    tools.length > 0 || ctx.toolIds.size === 0,
    `op ${raw.id}: tools must be a non-empty array`
  );
  for (const t of tools) {
    need(typeof t === 'string', `op ${raw.id}: tool entries must be strings`);
    need(ctx.toolIds.has(t), `op ${raw.id}: unknown tool "${t}"`);
  }
  const due = raw.due ?? ctx.dueSlot;
  need(
    isInt(due) && due >= 0,
    `op ${raw.id}: due must be a non-negative integer, got ${JSON.stringify(raw.due)}`
  );
  return {
    id: raw.id,
    machines: [...new Set(raw.machines)],
    minutes: raw.minutes,
    duration,
    fixture,
    tools: [...new Set(tools)],
    due,
  };
}

export function parseInstance(raw) {
  need(raw && typeof raw === 'object' && !Array.isArray(raw), 'instance must be a JSON object');
  const { machines } = raw;
  need(
    Array.isArray(machines) && machines.length > 0 && machines.every((m) => typeof m === 'string'),
    'machines must be a non-empty string array'
  );
  need(new Set(machines).size === machines.length, 'machines must be unique');

  const tools = raw.tools ?? [];
  need(Array.isArray(tools), 'tools must be an array');
  const toolIds = new Set();
  for (const t of tools) {
    need(t && typeof t === 'object' && typeof t.id === 'string', 'each tool requires a string id');
    need(!toolIds.has(t.id), `duplicate tool "${t.id}"`);
    need(
      isInt(t.life) && t.life >= 0,
      `tool ${t.id}: life must be a non-negative integer, got ${JSON.stringify(t.life)}`
    );
    toolIds.add(t.id);
  }

  const fixtures = raw.fixtures ?? [];
  need(
    Array.isArray(fixtures) && fixtures.every((f) => typeof f === 'string'),
    'fixtures must be a string array'
  );
  need(new Set(fixtures).size === fixtures.length, 'fixtures must be unique');

  need(
    isInt(raw.horizon) && raw.horizon > 0,
    `horizon must be a positive integer, got ${JSON.stringify(raw.horizon)}`
  );
  const slotMinutes = raw.slotMinutes ?? 1;
  need(
    isInt(slotMinutes) && slotMinutes > 0,
    `slotMinutes must be a positive integer, got ${JSON.stringify(slotMinutes)}`
  );
  const dueSlot = raw.dueSlot ?? raw.horizon;
  need(
    isInt(dueSlot) && dueSlot >= 0,
    `dueSlot must be a non-negative integer, got ${JSON.stringify(dueSlot)}`
  );

  need(
    Array.isArray(raw.operations) && raw.operations.length > 0,
    'operations must be a non-empty array'
  );
  const ctx = { machines, toolIds, fixtures, slotMinutes, dueSlot };
  const operations = raw.operations.map((o) => parseOperation(o, ctx));
  const opIds = new Set();
  for (const op of operations) {
    need(!opIds.has(op.id), `duplicate operation id "${op.id}"`);
    opIds.add(op.id);
  }

  return {
    machines: [...machines],
    tools: tools.map((t) => ({ id: t.id, life: t.life })),
    fixtures: [...fixtures],
    horizon: raw.horizon,
    slotMinutes,
    dueSlot,
    operations,
  };
}
