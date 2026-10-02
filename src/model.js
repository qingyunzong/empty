export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
  }
}

function isInt(v) {
  return Number.isInteger(v);
}

function fail(msg) {
  throw new ValidationError(msg);
}

function checkTime(value, what, { min = 0 } = {}) {
  if (!isInt(value)) fail(`${what} must be an integer, got ${JSON.stringify(value)}`);
  if (value < min) fail(`${what} must be >= ${min}, got ${value}`);
  return value;
}

export function validateInput(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('input must be a JSON object');
  }

  if (!Array.isArray(raw.tanks) || raw.tanks.length === 0) {
    fail('tanks must be a non-empty array');
  }
  const tanks = raw.tanks.map((t, i) => {
    if (t === null || typeof t !== 'object') fail(`tanks[${i}] must be an object`);
    if (typeof t.id !== 'string' || t.id === '') fail(`tanks[${i}].id must be a non-empty string`);
    if (typeof t.capacity !== 'number' || !Number.isFinite(t.capacity) || t.capacity <= 0) {
      fail(`tank ${t.id}: capacity must be a positive number, got ${JSON.stringify(t.capacity)}`);
    }
    if (!Array.isArray(t.materials) || t.materials.length === 0 || t.materials.some((m) => typeof m !== 'string' || m === '')) {
      fail(`tank ${t.id}: materials must be a non-empty array of strings`);
    }
    return { id: t.id, capacity: t.capacity, materials: new Set(t.materials) };
  });
  const tankIndex = new Map();
  for (let i = 0; i < tanks.length; i++) {
    if (tankIndex.has(tanks[i].id)) fail(`duplicate tank id ${tanks[i].id}`);
    tankIndex.set(tanks[i].id, i);
  }

  const defaultCleaningTime = raw.defaultCleaningTime ?? 0;
  checkTime(defaultCleaningTime, 'defaultCleaningTime');

  const cleaningMap = new Map();
  for (const [i, rule] of (raw.cleaning ?? []).entries()) {
    if (rule === null || typeof rule !== 'object') fail(`cleaning[${i}] must be an object`);
    if (typeof rule.from !== 'string' || typeof rule.to !== 'string') fail(`cleaning[${i}] needs string from/to`);
    checkTime(rule.time, `cleaning ${rule.from}->${rule.to} time`);
    cleaningMap.set(`${rule.from}->${rule.to}`, rule.time);
  }

  let horizon = null;
  if (raw.horizon !== undefined) {
    horizon = checkTime(raw.horizon, 'horizon', { min: 1 });
  }

  const tasks = (raw.tasks ?? []).map((t, i) => {
    if (t === null || typeof t !== 'object') fail(`tasks[${i}] must be an object`);
    const where = `task ${t.id ?? `[${i}]`}`;
    if (typeof t.id !== 'string' || t.id === '') fail(`tasks[${i}].id must be a non-empty string`);
    if (typeof t.material !== 'string' || t.material === '') fail(`${where}: material must be a non-empty string`);
    if (typeof t.minCapacity !== 'number' || !(t.minCapacity > 0)) fail(`${where}: minCapacity must be a positive number`);
    if (typeof t.maxCapacity !== 'number' || !(t.maxCapacity >= t.minCapacity)) {
      fail(`${where}: maxCapacity must be >= minCapacity (${t.minCapacity}), got ${JSON.stringify(t.maxCapacity)}`);
    }
    checkTime(t.duration, `${where}: duration`, { min: 1 });
    const locked = t.locked === true;
    let earliestStart = 0;
    if (t.earliestStart !== undefined) earliestStart = checkTime(t.earliestStart, `${where}: earliestStart`);
    let start = null;
    if (locked) {
      if (t.start === undefined) fail(`${where}: locked task requires a fixed start`);
      start = checkTime(t.start, `${where}: start`);
      earliestStart = start;
    } else if (t.start !== undefined) {
      fail(`${where}: start is only allowed on locked tasks (use earliestStart otherwise)`);
    }
    let deadline = null;
    if (t.deadline !== undefined) deadline = checkTime(t.deadline, `${where}: deadline`, { min: 1 });
    const effDeadline = deadline ?? horizon;
    if (effDeadline !== null && earliestStart + t.duration > effDeadline) {
      fail(`${where}: no feasible window (earliestStart ${earliestStart} + duration ${t.duration} > deadline ${effDeadline})`);
    }
    let tank = null;
    if (t.tank !== undefined) {
      if (typeof t.tank !== 'string' || !tankIndex.has(t.tank)) fail(`${where}: unknown tank ${JSON.stringify(t.tank)}`);
      tank = t.tank;
    }
    return {
      id: t.id, material: t.material,
      minCapacity: t.minCapacity, maxCapacity: t.maxCapacity,
      duration: t.duration, earliestStart, deadline,
      locked, start, tank, isHold: false,
    };
  });
  const taskIds = new Set();
  for (const t of tasks) {
    if (taskIds.has(t.id)) fail(`duplicate task id ${t.id}`);
    taskIds.add(t.id);
  }

  const holds = (raw.holds ?? []).map((h, i) => {
    if (h === null || typeof h !== 'object') fail(`holds[${i}] must be an object`);
    const where = `hold ${h.id ?? `[${i}]`}`;
    if (typeof h.id !== 'string' || h.id === '') fail(`holds[${i}].id must be a non-empty string`);
    if (typeof h.tank !== 'string' || !tankIndex.has(h.tank)) fail(`${where}: unknown tank ${JSON.stringify(h.tank)}`);
    checkTime(h.start, `${where}: start`);
    checkTime(h.duration, `${where}: duration`, { min: 1 });
    return {
      id: h.id, material: null,
      minCapacity: 0, maxCapacity: Infinity,
      duration: h.duration, earliestStart: h.start, deadline: null,
      locked: true, start: h.start, tank: h.tank, isHold: true,
      label: typeof h.label === 'string' ? h.label : null,
    };
  });

  let budget = raw.budget ?? 100000;
  checkTime(budget, 'budget');

  return { tanks, tankIndex, cleaningMap, defaultCleaningTime, horizon, tasks, holds, budget };
}
