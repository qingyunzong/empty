// Append-only journal: waves, assignments, moves, executions, rollbacks.
// Rollback never rewrites history; it appends status changes, compensation
// moves for already-executed moves, and reusable-pool entries for moves that
// never started.

export class JournalError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

const ENTITY_LEVELS = ['wave', 'task', 'move'];

export function parseJournal(lines) {
  const state = {
    waves: [],
    waveById: new Map(),
    tasks: [],
    taskById: new Map(),
    moves: [],
    moveById: new Map(),
    executions: [],
    execByMove: new Map(),
    reusable: [],
    rollbackRequests: [],
    errors: [],
  };
  for (const line of lines) {
    if (!line || typeof line !== 'object') continue;
    switch (line.type) {
      case 'wave': {
        const wave = { id: line.id, budget: line.budget, status: line.status ?? 'planned' };
        state.waves.push(wave);
        state.waveById.set(wave.id, wave);
        break;
      }
      case 'assignment': {
        const task = {
          id: line.task, wave: line.wave, shuttle: line.shuttle,
          seq: line.seq ?? 0, status: 'committed',
        };
        state.tasks.push(task);
        state.taskById.set(task.id, task);
        break;
      }
      case 'move': {
        const move = {
          id: line.id, wave: line.wave, task: line.task, shuttle: line.shuttle,
          kind: line.kind ?? 'task', from: line.from, to: line.to,
          aisles: (line.aisles ?? []).slice(),
          start: line.start, end: line.end,
          energy: line.energy ?? 0, duration: line.duration ?? 0,
          status: line.status ?? 'planned',
          compensates: line.compensates,
        };
        state.moves.push(move);
        state.moveById.set(move.id, move);
        break;
      }
      case 'execute': {
        const exec = { move: line.move, start: line.start, end: line.end ?? null };
        state.executions.push(exec);
        state.execByMove.set(exec.move, exec);
        break;
      }
      case 'status': {
        const table = { wave: state.waveById, task: state.taskById, move: state.moveById }[line.entity];
        const target = table?.get(line.id);
        if (target) target.status = line.status;
        break;
      }
      case 'reusable': {
        if (line.move) state.reusable.push(line.move);
        break;
      }
      case 'rollback': {
        state.rollbackRequests.push({ level: line.level, id: line.id });
        break;
      }
      default:
        break; // check/release/summary/error/rollback-result lines are ignored
    }
  }
  // Hierarchy integrity findings, consumed by verify.
  for (const task of state.tasks) {
    if (!state.waveById.has(task.wave)) {
      state.errors.push(`task ${task.id} references unknown wave ${task.wave}`);
    }
  }
  for (const move of state.moves) {
    if (!state.waveById.has(move.wave)) {
      state.errors.push(`move ${move.id} references unknown wave ${move.wave}`);
    }
    if (move.kind !== 'compensation' && !state.taskById.has(move.task)) {
      state.errors.push(`move ${move.id} references unknown task ${move.task}`);
    }
  }
  for (const exec of state.executions) {
    if (!state.moveById.has(exec.move)) {
      state.errors.push(`execute record references unknown move ${exec.move}`);
    }
  }
  return state;
}

// Flattened commit order: wave, its tasks (assignment order), their moves
// (journal order). This is the order rollback contiguity is checked against.
export function commitOrder(state) {
  const order = [];
  const tasksOf = new Map();
  for (const task of state.tasks) {
    if (!tasksOf.has(task.wave)) tasksOf.set(task.wave, []);
    tasksOf.get(task.wave).push(task);
  }
  const movesOf = new Map();
  const orphanMoves = new Map();
  for (const move of state.moves) {
    if (move.kind === 'compensation') continue; // rollback artifacts are not commit-order entities
    const key = move.task;
    if (state.taskById.has(key)) {
      if (!movesOf.has(key)) movesOf.set(key, []);
      movesOf.get(key).push(move);
    } else {
      if (!orphanMoves.has(move.wave)) orphanMoves.set(move.wave, []);
      orphanMoves.get(move.wave).push(move);
    }
  }
  for (const wave of state.waves) {
    order.push({ level: 'wave', id: wave.id, entity: wave });
    for (const task of tasksOf.get(wave.id) ?? []) {
      order.push({ level: 'task', id: task.id, entity: task });
      for (const move of movesOf.get(task.id) ?? []) {
        order.push({ level: 'move', id: move.id, entity: move });
      }
    }
    for (const move of orphanMoves.get(wave.id) ?? []) {
      order.push({ level: 'move', id: move.id, entity: move });
    }
  }
  return order;
}

function isActive(entry) {
  const s = entry.entity.status;
  return s !== 'rolled-back' && s !== 'compensated' && s !== 'reusable';
}

function isDescendant(entry, target) {
  if (target.level === 'wave') {
    if (entry.level === 'task') return entry.entity.wave === target.id;
    if (entry.level === 'move') return entry.entity.wave === target.id;
    return false;
  }
  if (target.level === 'task') {
    return entry.level === 'move' && entry.entity.task === target.id;
  }
  return false; // moves have no descendants
}

// Rollback must be contiguous from the top of the commit stack: every active
// entity committed after the target has to be a descendant of the target
// (those are cascaded). Anything else means the request skips a level.
function checkContiguity(state, target) {
  const order = commitOrder(state);
  const targetIdx = order.findIndex((e) => e.level === target.level && e.id === target.id);
  if (targetIdx === -1 || !isActive(order[targetIdx])) {
    throw new JournalError('ENTITY_NOT_FOUND',
      `${target.level} ${target.id} is not an active committed entity`,
      { level: target.level, id: target.id });
  }
  for (let i = targetIdx + 1; i < order.length; i++) {
    const entry = order[i];
    if (!isActive(entry)) continue;
    if (!isDescendant(entry, order[targetIdx])) {
      throw new JournalError('ROLLBACK_LEVEL_VIOLATION',
        `cannot roll back ${target.level} ${target.id}: ${entry.level} ${entry.id} was committed after it and is not its descendant`,
        { level: target.level, id: target.id, blocking: { level: entry.level, id: entry.id } });
    }
  }
  return order[targetIdx];
}

function cascadeMoves(state, target) {
  let moves;
  if (target.level === 'wave') {
    moves = state.moves.filter((m) => m.wave === target.id && m.kind !== 'compensation');
  } else if (target.level === 'task') {
    moves = state.moves.filter((m) => m.task === target.id && m.kind !== 'compensation');
  } else {
    moves = [state.moveById.get(target.id)].filter(Boolean);
  }
  // Reverse causal order: latest moves are undone first.
  return moves.reverse();
}

export function applyRollback(state, { level, id }) {
  if (!ENTITY_LEVELS.includes(level)) {
    throw new JournalError('ENTITY_NOT_FOUND', `unknown rollback level ${level}`, { level });
  }
  checkContiguity(state, { level, id });

  const lines = [];
  const compensated = [];
  const reusable = [];
  let compensationEnergy = 0;

  let clock = 0;
  for (const move of state.moves) {
    if (Number.isFinite(move.end)) clock = Math.max(clock, move.end);
  }
  for (const exec of state.executions) {
    if (Number.isFinite(exec.end)) clock = Math.max(clock, exec.end);
  }

  for (const move of cascadeMoves(state, { level, id })) {
    if (move.status === 'compensated' || move.status === 'reusable') continue;
    const exec = state.execByMove.get(move.id);
    if (exec) {
      // Executed (or in-flight) moves are compensated, never erased.
      const compensation = {
        type: 'move', wave: move.wave, task: move.task,
        id: `C~${move.id}`, kind: 'compensation', compensates: move.id,
        shuttle: move.shuttle, from: move.to, to: move.from,
        aisles: move.aisles.slice().reverse(),
        start: clock, end: clock + move.duration,
        energy: move.energy, duration: move.duration, status: 'executed',
      };
      clock = compensation.end;
      compensationEnergy += compensation.energy;
      compensated.push(move.id);
      lines.push({ type: 'status', entity: 'move', id: move.id, status: 'compensated' });
      lines.push(compensation);
    } else {
      // Never started: the plan is returned to the pool for reuse.
      reusable.push(move.id);
      lines.push({ type: 'status', entity: 'move', id: move.id, status: 'reusable' });
      lines.push({
        type: 'reusable',
        move: {
          id: move.id, from: move.from, to: move.to,
          aisles: move.aisles.slice(), energy: move.energy, duration: move.duration,
        },
      });
    }
  }

  const affectedTasks = level === 'move'
    ? [state.taskById.get(state.moveById.get(id)?.task)].filter(Boolean)
    : state.tasks.filter((t) => (level === 'wave' ? t.wave === id : t.id === id));
  for (const task of affectedTasks) {
    lines.push({ type: 'status', entity: 'task', id: task.id, status: 'rolled-back' });
  }
  if (level === 'wave') {
    lines.push({ type: 'status', entity: 'wave', id, status: 'rolled-back' });
  }
  lines.push({
    type: 'rollback-result', level, id, status: 'ok',
    compensated, reusable, compensationEnergy,
  });
  return { lines, compensated, reusable, compensationEnergy };
}

// Causal release evaluation. A planned move may only be released when every
// move it causally depends on has completed and no aisle it needs is held by
// an in-flight move. Otherwise it stays pending with explicit, resolvable
// unblock conditions. Aisles with no recorded occupant never block.
export function evaluateRelease(state) {
  const activeWaveIds = new Set(state.waves.filter((w) => w.status !== 'rolled-back').map((w) => w.id));
  const liveMoves = state.moves.filter((m) =>
    (activeWaveIds.has(m.wave) || m.kind === 'compensation') &&
    m.status !== 'reusable' && m.status !== 'compensated');

  const isCompleted = (move) => {
    if (move.kind === 'compensation') return true;
    const exec = state.execByMove.get(move.id);
    return exec !== undefined && exec.end !== null;
  };
  const isExecuting = (move) => {
    const exec = state.execByMove.get(move.id);
    return exec !== undefined && exec.end === null;
  };

  const byShuttle = new Map();
  for (const move of liveMoves) {
    if (!byShuttle.has(move.shuttle)) byShuttle.set(move.shuttle, []);
    byShuttle.get(move.shuttle).push(move);
  }

  const releases = [];
  for (const [, seq] of [...byShuttle.entries()].sort()) {
    for (let i = 0; i < seq.length; i++) {
      const move = seq[i];
      if (isCompleted(move) || isExecuting(move)) continue;
      const blockedBy = [];
      const pred = i > 0 ? seq[i - 1] : null;
      if (pred && !isCompleted(pred)) {
        blockedBy.push({ move: pred.id, reason: 'causal-predecessor', condition: 'complete' });
      }
      for (const other of liveMoves) {
        if (other.id === move.id || !isExecuting(other)) continue;
        const shared = move.aisles.filter((a) => other.aisles.includes(a));
        for (const aisle of shared) {
          blockedBy.push({ move: other.id, reason: 'aisle-occupied', aisle, condition: 'complete' });
        }
      }
      releases.push({
        move: move.id, wave: move.wave, task: move.task, shuttle: move.shuttle,
        status: blockedBy.length > 0 ? 'pending' : 'released',
        blockedBy,
      });
    }
  }
  return releases;
}
