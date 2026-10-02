export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.exitCode = 2;
  }
}

function fail(message) {
  throw new ValidationError(message);
}

export function requireInt(value, what, { min = null } = {}) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${what} must be an integer, got ${JSON.stringify(value)}`);
  }
  if (min !== null && value < min) {
    fail(`${what} must be >= ${min}, got ${value}`);
  }
  return value;
}

function requireStringList(value, what) {
  if (!Array.isArray(value) || value.length === 0 || value.some((v) => typeof v !== 'string' || v === '')) {
    fail(`${what} must be a non-empty array of strings`);
  }
  return [...new Set(value)];
}

export function normalizeOp(raw, ctx) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('each op must be an object');
  }
  const id = raw.id;
  if (typeof id !== 'string' || id === '') fail('op id must be a non-empty string');

  const machines = requireStringList(raw.machines, `op '${id}' machines`);
  for (const m of machines) {
    if (!ctx.machines.includes(m)) fail(`unknown machine '${m}' in op '${id}'`);
  }

  const tools = requireStringList(raw.tools, `op '${id}' tools`);
  for (const t of tools) {
    if (!(t in ctx.tools)) fail(`unknown tool '${t}' in op '${id}'`);
  }

  const cut = requireInt(raw.cut, `op '${id}' cut`, { min: 1 });

  const fixture = raw.fixture ?? null;
  if (fixture !== null && !ctx.fixtures.includes(fixture)) {
    fail(`unknown fixture '${fixture}' in op '${id}'`);
  }

  const due = raw.due === undefined ? ctx.slots - 1 : requireInt(raw.due, `op '${id}' due`, { min: 0 });

  return { id, machines, tools, cut, fixture, due };
}

export function validateProblem(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('problem must be a JSON object');
  }

  const slots = requireInt(raw.slots, 'slots', { min: 1 });

  const machines = requireStringList(raw.machines, 'machines');

  if (raw.tools === null || typeof raw.tools !== 'object' || Array.isArray(raw.tools) || Object.keys(raw.tools).length === 0) {
    fail('tools must be a non-empty object mapping tool name to {life}');
  }
  const tools = {};
  for (const [name, def] of Object.entries(raw.tools)) {
    if (def === null || typeof def !== 'object') fail(`tool '${name}' must be an object with integer life`);
    tools[name] = { life: requireInt(def.life, `tool '${name}' life`, { min: 0 }) };
  }

  if (raw.fixtures !== undefined && (!Array.isArray(raw.fixtures) || raw.fixtures.some((v) => typeof v !== 'string' || v === ''))) {
    fail('fixtures must be an array of strings');
  }
  const fixtures = [...new Set(raw.fixtures ?? [])];

  if (!Array.isArray(raw.ops) || raw.ops.length === 0) {
    fail('ops must be a non-empty array');
  }
  const ctx = { machines, tools, fixtures, slots };
  const seen = new Set();
  const ops = raw.ops.map((rawOp) => {
    const op = normalizeOp(rawOp, ctx);
    if (seen.has(op.id)) fail(`duplicate op id '${op.id}'`);
    seen.add(op.id);
    return op;
  });

  return { slots, machines, tools, fixtures, ops };
}

export function validateAssignmentValue(op, value, problem) {
  if (value === null || typeof value !== 'object') {
    fail(`assignment for op '${op.id}' must be an object {machine, slot, tool}`);
  }
  const { machine, slot, tool } = value;
  if (!op.machines.includes(machine)) {
    fail(`assignment for op '${op.id}': machine '${machine}' is not in its candidate set`);
  }
  requireInt(slot, `assignment for op '${op.id}' slot`, { min: 0 });
  if (slot >= problem.slots) {
    fail(`assignment for op '${op.id}': slot ${slot} out of range [0, ${problem.slots})`);
  }
  if (!op.tools.includes(tool)) {
    fail(`assignment for op '${op.id}': tool '${tool}' is not in its candidate set`);
  }
  return { machine, slot, tool };
}
