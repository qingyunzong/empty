import { SchedError, ZERO, cmp, parseRat } from './rational.js';
import { solveTasks } from './scheduler.js';

const TASK_FIELDS = ['release', 'deadline', 'duration', 'weight'];

export function normalizeTask(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SchedError('E_VALIDATION', 'task must be an object');
  }
  const id = input.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new SchedError('E_VALIDATION', 'task.id must be a non-empty string');
  }
  for (const f of TASK_FIELDS) {
    if (!(f in input)) throw new SchedError('E_VALIDATION', `missing field: ${f}`);
  }
  const release = parseRat(input.release, 'release');
  const deadline = parseRat(input.deadline, 'deadline');
  const duration = parseRat(input.duration, 'duration');
  const weight = parseRat(input.weight, 'weight');
  if (cmp(release, deadline) > 0) {
    throw new SchedError('E_EMPTY', 'release > deadline: empty window');
  }
  if (cmp(duration, ZERO) <= 0) {
    throw new SchedError('E_EMPTY', 'duration <= 0: empty duration');
  }
  return { id, release, deadline, duration, weight };
}

export class Store {
  #versions = [new Map()];
  #idx = 0;

  get version() {
    return this.#idx;
  }

  get versionCount() {
    return this.#versions.length;
  }

  current() {
    return this.#versions[this.#idx];
  }

  #commit(map) {
    this.#versions.length = this.#idx + 1; // drop redo tail
    this.#versions.push(map);
    this.#idx++;
  }

  add(input) {
    const task = normalizeTask(input);
    const cur = this.current();
    if (cur.has(task.id)) {
      throw new SchedError('E_DUPLICATE', `task already exists: ${task.id}`);
    }
    const next = new Map(cur);
    next.set(task.id, task);
    this.#commit(next);
    return { version: this.#idx };
  }

  update(id, patch = {}) {
    const cur = this.current();
    const existing = cur.get(id);
    if (!existing) throw new SchedError('E_NOT_FOUND', `no task: ${id}`);
    if (patch.id !== undefined && patch.id !== id) {
      throw new SchedError('E_VALIDATION', 'cannot change task id');
    }
    // Existing rationals round-trip through parseRat ({n, d} form), so a
    // partial patch is validated as a full task before any version is written.
    const merged = { ...existing, ...patch, id };
    const task = normalizeTask(merged);
    const next = new Map(cur);
    next.set(id, task);
    this.#commit(next);
    return { version: this.#idx };
  }

  remove(id) {
    const cur = this.current();
    if (!cur.has(id)) throw new SchedError('E_NOT_FOUND', `no task: ${id}`);
    const next = new Map(cur);
    next.delete(id);
    this.#commit(next);
    return { version: this.#idx };
  }

  undo() {
    if (this.#idx > 0) this.#idx--;
    return { version: this.#idx };
  }

  redo() {
    if (this.#idx < this.#versions.length - 1) this.#idx++;
    return { version: this.#idx };
  }

  solve() {
    return { version: this.#idx, ...solveTasks(this.current().values()) };
  }
}
