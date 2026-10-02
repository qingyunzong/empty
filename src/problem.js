// Problem loading and validation. Any violation of the input contract
// (illegal times, illegal capacities, unknown references) raises InputError,
// which the CLI maps to exit code 2.

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

const isInt = Number.isInteger;

function fail(message) {
  throw new InputError(message);
}

export function isCompatible(problem, taskMaterial, tankMaterial) {
  if (!problem.compatibility) return true;
  const allowed = problem.compatibility[taskMaterial];
  return Array.isArray(allowed) && allowed.includes(tankMaterial);
}

export function validateProblem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('problem must be a JSON object');
  }

  const horizon = raw.horizon;
  if (!isInt(horizon) || horizon <= 0) {
    fail('horizon must be a positive integer');
  }

  if (!Array.isArray(raw.tanks) || raw.tanks.length === 0) {
    fail('tanks must be a non-empty array');
  }
  const tanks = raw.tanks.map((tank, i) => {
    if (!tank || typeof tank.id !== 'string' || tank.id.length === 0) {
      fail(`tanks[${i}]: non-empty string id required`);
    }
    if (typeof tank.material !== 'string' || tank.material.length === 0) {
      fail(`tank ${tank.id}: material must be a non-empty string`);
    }
    if (!isInt(tank.capacity) || tank.capacity <= 0) {
      fail(`tank ${tank.id}: capacity must be a positive integer`);
    }
    return { id: tank.id, material: tank.material, capacity: tank.capacity };
  });
  const tankIds = new Set(tanks.map((t) => t.id));
  if (tankIds.size !== tanks.length) fail('tank ids must be unique');
  const tankById = new Map(tanks.map((t) => [t.id, t]));

  let compatibility = null;
  if (raw.compatibility !== undefined) {
    if (!raw.compatibility || typeof raw.compatibility !== 'object' || Array.isArray(raw.compatibility)) {
      fail('compatibility must be an object mapping task material to allowed tank materials');
    }
    compatibility = {};
    for (const [material, allowed] of Object.entries(raw.compatibility)) {
      if (!Array.isArray(allowed) || allowed.some((m) => typeof m !== 'string')) {
        fail(`compatibility[${material}] must be an array of tank material strings`);
      }
      compatibility[material] = [...allowed];
    }
  }

  const cleaning = (raw.cleaning ?? []).map((rule, i) => {
    if (!rule || typeof rule.from !== 'string' || typeof rule.to !== 'string') {
      fail(`cleaning[${i}]: from and to material strings required`);
    }
    if (!isInt(rule.time) || rule.time < 0) {
      fail(`cleaning[${i}]: time must be a non-negative integer`);
    }
    return { from: rule.from, to: rule.to, time: rule.time };
  });

  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    fail('tasks must be a non-empty array');
  }
  const tasks = raw.tasks.map((task, i) => {
    const label = task && typeof task.id === 'string' && task.id ? `task ${task.id}` : `tasks[${i}]`;
    if (!task || typeof task.id !== 'string' || task.id.length === 0) {
      fail(`tasks[${i}]: non-empty string id required`);
    }
    if (typeof task.material !== 'string' || task.material.length === 0) {
      fail(`${label}: material must be a non-empty string`);
    }
    if (!isInt(task.minCapacity) || task.minCapacity <= 0) {
      fail(`${label}: minCapacity must be a positive integer`);
    }
    if (!isInt(task.maxCapacity) || task.maxCapacity <= 0) {
      fail(`${label}: maxCapacity must be a positive integer`);
    }
    if (task.minCapacity > task.maxCapacity) {
      fail(`${label}: minCapacity must not exceed maxCapacity`);
    }
    if (!isInt(task.earliestStart) || task.earliestStart < 0) {
      fail(`${label}: earliestStart must be a non-negative integer`);
    }
    if (!isInt(task.duration) || task.duration <= 0) {
      fail(`${label}: duration must be a positive integer`);
    }
    let latestStart = null;
    if (task.latestStart !== undefined && task.latestStart !== null) {
      if (!isInt(task.latestStart) || task.latestStart < 0) {
        fail(`${label}: latestStart must be a non-negative integer`);
      }
      if (task.latestStart < task.earliestStart) {
        fail(`${label}: latestStart must not be earlier than earliestStart`);
      }
      latestStart = task.latestStart;
    }
    const locked = task.locked === true;
    let tank = null;
    let start = null;
    if (locked) {
      if (typeof task.tank !== 'string' || !tankById.has(task.tank)) {
        fail(`${label}: locked task requires a valid tank id`);
      }
      if (!isInt(task.start) || task.start < 0) {
        fail(`${label}: locked task requires a non-negative integer start`);
      }
      tank = task.tank;
      start = task.start;
      const effectiveLatest = latestStart ?? horizon - task.duration;
      if (start < task.earliestStart || start > effectiveLatest) {
        fail(`${label}: locked start ${start} is outside the task time window`);
      }
      const fixedTank = tankById.get(tank);
      if (fixedTank.capacity < task.minCapacity || fixedTank.capacity > task.maxCapacity) {
        fail(`${label}: locked tank ${tank} capacity ${fixedTank.capacity} outside [${task.minCapacity}, ${task.maxCapacity}]`);
      }
      const probe = { compatibility };
      if (!isCompatible(probe, task.material, fixedTank.material)) {
        fail(`${label}: locked tank ${tank} material ${fixedTank.material} incompatible with ${task.material}`);
      }
    }
    return {
      id: task.id,
      material: task.material,
      minCapacity: task.minCapacity,
      maxCapacity: task.maxCapacity,
      earliestStart: task.earliestStart,
      latestStart,
      duration: task.duration,
      locked,
      tank,
      start,
    };
  });
  const taskIds = new Set(tasks.map((t) => t.id));
  if (taskIds.size !== tasks.length) fail('task ids must be unique');

  if (compatibility) {
    for (const task of tasks) {
      if (!(task.material in compatibility)) {
        fail(`no compatibility entry for material ${task.material} (task ${task.id})`);
      }
    }
  }

  return { horizon, tanks, tasks, compatibility, cleaning };
}

export function validateHold(raw) {
  if (!raw || typeof raw !== 'object') fail('hold must be an object');
  if (typeof raw.id !== 'string' || raw.id.length === 0) fail('hold: non-empty string id required');
  if (typeof raw.tank !== 'string' || raw.tank.length === 0) fail(`hold ${raw.id}: tank id required`);
  if (!isInt(raw.start) || raw.start < 0) fail(`hold ${raw.id}: start must be a non-negative integer`);
  if (!isInt(raw.duration) || raw.duration <= 0) fail(`hold ${raw.id}: duration must be a positive integer`);
  if (raw.material !== undefined && raw.material !== null && typeof raw.material !== 'string') {
    fail(`hold ${raw.id}: material must be a string when given`);
  }
  return {
    id: raw.id,
    tank: raw.tank,
    start: raw.start,
    duration: raw.duration,
    material: raw.material ?? null,
  };
}
