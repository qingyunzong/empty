import { buildTree, ValidationError } from './tree.js';
import { Scheduler } from './scheduler.js';

function isNonNegInt(value) {
  return Number.isInteger(value) && value >= 0;
}

export function validateScenario(scenario) {
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    throw new ValidationError('INVALID_CONFIG', 'scenario must be an object');
  }
  const starveThreshold = scenario.starveThreshold ?? 3;
  if (!isNonNegInt(starveThreshold)) {
    throw new ValidationError('INVALID_CONFIG', 'starveThreshold must be a non-negative integer');
  }
  if (!Array.isArray(scenario.tenants)) {
    throw new ValidationError('INVALID_CONFIG', 'scenario.tenants must be an array');
  }
  const orders = scenario.orders ?? [];
  const commands = scenario.commands ?? [];
  if (!Array.isArray(orders) || !Array.isArray(commands)) {
    throw new ValidationError('INVALID_CONFIG', 'orders and commands must be arrays');
  }

  const seenOrders = new Set();
  const normOrders = orders.map((order) => {
    if (!order || typeof order.id !== 'string' || order.id.length === 0) {
      throw new ValidationError('INVALID_ORDER', 'every order needs a non-empty string id');
    }
    if (seenOrders.has(order.id)) {
      throw new ValidationError('DUPLICATE_ORDER', `duplicate order id: ${order.id}`);
    }
    seenOrders.add(order.id);
    if (typeof order.tenant !== 'string' || order.tenant.length === 0) {
      throw new ValidationError('INVALID_ORDER', `order ${order.id} needs a tenant`);
    }
    if (!Number.isInteger(order.units) || order.units <= 0) {
      throw new ValidationError('INVALID_ORDER', `order ${order.id} units must be a positive integer`);
    }
    const priority = order.priority ?? 0;
    const submit = order.submit ?? 0;
    if (!Number.isInteger(priority)) {
      throw new ValidationError('INVALID_ORDER', `order ${order.id} priority must be an integer`);
    }
    if (!isNonNegInt(submit)) {
      throw new ValidationError('INVALID_ORDER', `order ${order.id} submit must be a non-negative integer`);
    }
    return { id: order.id, tenant: order.tenant, units: order.units, priority, submit };
  });

  const normCommands = commands.map((cmd, index) => {
    if (!cmd || (cmd.cmd !== 'tick' && cmd.cmd !== 'reclaim')) {
      throw new ValidationError('INVALID_COMMAND', `command #${index} must be {cmd:"tick"|"reclaim", time}`);
    }
    if (!isNonNegInt(cmd.time)) {
      throw new ValidationError('INVALID_COMMAND', `command #${index} time must be a non-negative integer`);
    }
    if (cmd.cmd === 'reclaim' && (typeof cmd.tenant !== 'string' || cmd.tenant.length === 0)) {
      throw new ValidationError('INVALID_COMMAND', `reclaim command #${index} needs a tenant`);
    }
    return cmd.cmd === 'tick'
      ? { cmd: 'tick', time: cmd.time, seq: index }
      : { cmd: 'reclaim', tenant: cmd.tenant, time: cmd.time, seq: index };
  });
  normCommands.sort((a, b) => a.time - b.time || a.seq - b.seq);

  return { tenants: scenario.tenants, orders: normOrders, commands: normCommands, starveThreshold };
}

export function prepare(scenario) {
  const cfg = validateScenario(scenario);
  const tree = buildTree(cfg.tenants);
  for (const order of cfg.orders) {
    if (!tree.nodes.has(order.tenant)) {
      throw new ValidationError('UNKNOWN_TENANT', `order ${order.id} references unknown tenant ${order.tenant}`);
    }
  }
  for (const cmd of cfg.commands) {
    if (cmd.cmd === 'reclaim' && !tree.nodes.has(cmd.tenant)) {
      throw new ValidationError('UNKNOWN_TENANT', `reclaim references unknown tenant ${cmd.tenant}`);
    }
  }
  return { cfg, tree };
}

export function runScenario(scenario) {
  const { cfg, tree } = prepare(scenario);
  const scheduler = new Scheduler({
    tree,
    orders: cfg.orders,
    starveThreshold: cfg.starveThreshold,
  });

  let time = 0;
  for (const cmd of cfg.commands) {
    time = cmd.time;
    if (cmd.cmd === 'tick') {
      scheduler.schedulePass(time);
    } else {
      scheduler.reclaim(cmd.tenant, time);
      scheduler.schedulePass(time);
    }
  }

  const nodes = [...scheduler.nodes.values()]
    .map((node) => {
      const limit = scheduler.effLimit(node.id);
      const entry = {
        id: node.id,
        parent: node.parentId,
        used: node.used,
        lentOut: node.lentOut,
        borrowedIn: node.borrowedIn,
        limit,
        headroom: limit - node.used,
      };
      if (node.id === scheduler.rootId) entry.capacity = node.capacity;
      else entry.guarantee = node.guarantee;
      return entry;
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const schedule = scheduler.orders.map((order) => {
    const remaining = scheduler.remaining(order);
    return {
      id: order.id,
      tenant: order.tenant,
      units: order.units,
      active: order.active,
      remaining,
      priority: order.priority,
      submit: order.submit,
      status: remaining === 0 ? 'scheduled' : order.active > 0 ? 'partial' : 'waiting',
    };
  });

  const rootUsed = scheduler.nodes.get(scheduler.rootId).used;
  const capacity = scheduler.nodes.get(scheduler.rootId).capacity;

  return {
    ok: true,
    time,
    starveThreshold: cfg.starveThreshold,
    nodes,
    borrowChain: scheduler.borrowEvents,
    borrows: scheduler.borrows.filter((b) => b.amount > 0),
    reclaims: scheduler.reclaims,
    preemptions: scheduler.preemptions,
    schedule,
    utilization: {
      capacity,
      used: rootUsed,
      idle: capacity - rootUsed,
      ratio: capacity === 0 ? 0 : rootUsed / capacity,
    },
  };
}
