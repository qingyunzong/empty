// Append-only journal and hierarchical rollback.
//
// Journal record types:
//   wave:   {type:'wave', id, budget}
//   task:   {type:'task', id, wave}
//   move:   {type:'move', id, task, wave, shuttle, lane, from, to, energy, duration, status}
//   status: {type:'status', id, status}            // planned|executing|done
//   rollback: {type:'rollback', id, level}         // marker written by rollback
//   compensation / cancel: emitted by rollback, never erase history.
//
// Rollback cascades wave -> tasks -> moves. Moves already started
// (executing|done) are compensated with an inverse move; unstarted moves are
// cancelled and flagged reusable for later waves. Rolling back a target that
// is already settled (itself or any ancestor already rolled back) is a
// level-skipping rollback and fails with code LEVEL_SKIP.

export class RollbackError extends Error {
  constructor(code, message, id) {
    super(message);
    this.code = code;
    this.id = id;
  }
}

export function loadJournal(records) {
  const waves = new Map();
  const tasks = new Map();
  const moves = new Map();
  const rolledBack = new Set();
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.type === 'wave') {
      waves.set(rec.id, rec);
    } else if (rec.type === 'task') {
      tasks.set(rec.id, rec);
    } else if (rec.type === 'move') {
      moves.set(rec.id, { ...rec, status: rec.status ?? 'planned' });
    } else if (rec.type === 'status') {
      const mv = moves.get(rec.id);
      if (mv) mv.status = rec.status;
    } else if (rec.type === 'rollback') {
      rolledBack.add(rec.id);
    }
  }
  return { waves, tasks, moves, rolledBack };
}

function ancestorsOf(journal, level, id) {
  const chain = [];
  if (level === 'move') {
    const mv = journal.moves.get(id);
    const taskId = mv.task;
    chain.push(taskId);
    const task = journal.tasks.get(taskId);
    if (task && task.wave) chain.push(task.wave);
    else if (mv.wave) chain.push(mv.wave);
  } else if (level === 'task') {
    const task = journal.tasks.get(id);
    if (task && task.wave) chain.push(task.wave);
  }
  return chain;
}

function levelOf(journal, id) {
  if (journal.waves.has(id)) return 'wave';
  if (journal.tasks.has(id)) return 'task';
  if (journal.moves.has(id)) return 'move';
  return null;
}

function movesUnder(journal, level, id) {
  const result = [];
  for (const mv of journal.moves.values()) {
    if (level === 'move' && mv.id === id) result.push(mv);
    else if (level === 'task' && mv.task === id) result.push(mv);
    else if (level === 'wave') {
      const task = journal.tasks.get(mv.task);
      if ((task && task.wave === id) || mv.wave === id) result.push(mv);
    }
  }
  result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return result;
}

export function rollback(journal, id) {
  const level = levelOf(journal, id);
  if (!level) {
    throw new RollbackError('UNKNOWN_TARGET', `no wave/task/move with id ${id}`, id);
  }
  if (journal.rolledBack.has(id)) {
    throw new RollbackError('LEVEL_SKIP', `target ${id} already rolled back`, id);
  }
  for (const anc of ancestorsOf(journal, level, id)) {
    if (journal.rolledBack.has(anc)) {
      throw new RollbackError(
        'LEVEL_SKIP',
        `ancestor ${anc} already rolled back; ${id} is covered by that cascade`,
        id,
      );
    }
  }

  const entries = [{ type: 'rollback', id, level }];
  for (const mv of movesUnder(journal, level, id)) {
    if (mv.status === 'done' || mv.status === 'executing') {
      entries.push({
        type: 'compensation',
        id: `cmp:${mv.id}`,
        of: mv.id,
        task: mv.task,
        wave: mv.wave,
        lane: mv.lane,
        from: mv.to,
        to: mv.from,
        energy: mv.energy,
        duration: mv.duration,
      });
    } else {
      entries.push({ type: 'cancel', id: mv.id, reusable: true });
    }
  }
  return entries;
}
