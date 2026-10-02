import { EventLog, recoverLogFile } from './log.js';

export const EXIT5_CODES = new Set([
  'E_VOLUME_EXCEEDS_PLATE',
  'E_BUDGET_NEGATIVE',
  'E_INSUFFICIENT_BUDGET',
  'E_COOLDOWN_CONFLICT',
]);

const MESSAGES = {
  E_VOLUME_EXCEEDS_PLATE: 'volume exceeds available plate wells',
  E_BUDGET_NEGATIVE: 'operation would drive project budget negative',
  E_INSUFFICIENT_BUDGET: 'project budget cannot cover task cost',
  E_COOLDOWN_CONFLICT: 'adjacent segments exceed maximum temperature jump',
  E_DUPLICATE_TASK: 'task id already exists',
  E_UNKNOWN_TASK: 'unknown task id',
  E_INVALID_TASK: 'invalid task definition',
  E_INVALID_VOLUME: 'volume must be positive',
  E_INVALID_OP: 'invalid operation payload',
  E_INVALID_STATE: 'operation not allowed in current task state',
  E_NO_UNDO: 'operation stack is empty',
  E_TASK_RUNNING: 'task is currently running',
  E_CONTAMINATED_REVIVE: 'cannot resurrect confirmed contaminated wells',
  E_UNKNOWN_OP: 'unknown operation',
};

export function exitCodeFor(failures) {
  if (!failures.length) return 0;
  return failures.some((f) => EXIT5_CODES.has(f.code)) ? 5 : 1;
}

export class Engine {
  constructor(config, { log = null, logPath = null } = {}) {
    this.config = config;
    this.log = log ?? new EventLog([], logPath);
    this.projects = new Map();
    this.tasks = new Map();
    this.contaminatedWells = 0;
    this.usedWells = 0;
    this.opStack = [];
    this.failures = [];
    this.appliedOps = new Set();
    this.rrCounter = 0;
    this.replaying = false;
    this._opIndex = -1;
  }

  static recover(config, logText, { logPath = null } = {}) {
    const { log } = EventLog.recover(logText, logPath);
    return Engine._fromLog(config, log, logPath);
  }

  static recoverFile(config, logPath) {
    const log = recoverLogFile(logPath);
    return Engine._fromLog(config, log, logPath);
  }

  static _fromLog(config, log, logPath) {
    const engine = new Engine(config, { log, logPath });
    engine.replaying = true;
    for (const entry of log.entries) {
      if (entry.type !== 'op') continue;
      engine.applyOp(entry.data.op, entry.data.opIndex, 0, null);
    }
    engine.replaying = false;
    return engine;
  }

  wellsNeeded(volume) {
    return Math.ceil(volume / this.config.wellCapacity);
  }

  availableWells() {
    return this.config.plateWells - this.contaminatedWells - this.usedWells;
  }

  _project(name) {
    let p = this.projects.get(name);
    if (!p) {
      p = { name, budget: 0, lastServedSeq: -1 };
      this.projects.set(name, p);
    }
    return p;
  }

  _emit(type, data) {
    if (!this.replaying) this.log.append(type, data);
  }

  applyOp(op, opIndex, now = 0, rt = null) {
    if (this.appliedOps.has(opIndex)) return null;
    this.appliedOps.add(opIndex);
    this._opIndex = opIndex;
    let code;
    switch (op?.op) {
      case 'enqueue':
        code = this._enqueue(op, now);
        break;
      case 'correct':
        code = this._correct(op);
        break;
      case 'budget':
        code = this._budget(op);
        break;
      case 'abort':
        code = this._abort(op, now, rt);
        break;
      case 'undo':
        code = this._undo();
        break;
      default:
        code = 'E_UNKNOWN_OP';
    }
    if (code) this.failures.push({ opIndex, op, code, message: MESSAGES[code] ?? code });
    this._emit('op', { opIndex, op, code });
    return code;
  }

  _enqueue(op, now) {
    const t = op.task;
    if (!t || typeof t.id !== 'string' || t.id.length === 0) return 'E_INVALID_TASK';
    if (this.tasks.has(t.id)) return 'E_DUPLICATE_TASK';
    if (!Number.isFinite(t.volume) || t.volume <= 0) return 'E_INVALID_VOLUME';
    if (!Array.isArray(t.segments) || t.segments.length === 0) return 'E_INVALID_TASK';
    for (const s of t.segments) {
      if (!s || !Number.isFinite(s.temp) || !Number.isFinite(s.duration) || s.duration <= 0) {
        return 'E_INVALID_TASK';
      }
    }
    if (this.wellsNeeded(t.volume) > this.availableWells()) return 'E_VOLUME_EXCEEDS_PLATE';
    for (let i = 1; i < t.segments.length; i++) {
      if (Math.abs(t.segments[i].temp - t.segments[i - 1].temp) > this.config.maxTempJump) {
        return 'E_COOLDOWN_CONFLICT';
      }
    }
    const projectName = typeof t.project === 'string' && t.project ? t.project : 'default';
    const project = this._project(projectName);
    const cost = t.volume * this.config.costPerUnit;
    if (project.budget < cost) return 'E_INSUFFICIENT_BUDGET';
    project.budget -= cost;
    const task = {
      id: t.id,
      project: projectName,
      volume: t.volume,
      priority: Number.isFinite(t.priority) ? t.priority : 0,
      segments: t.segments.map((s) => ({ temp: s.temp, duration: s.duration })),
      status: 'queued',
      segmentIndex: 0,
      arrivedAt: now,
      cost,
      startedAt: null,
      completedAt: null,
      channel: null,
    };
    this.tasks.set(task.id, task);
    this.usedWells += this.wellsNeeded(task.volume);
    this.opStack.push({ kind: 'enqueue', taskId: task.id, cost, project: projectName });
    this._emit('charge', {
      id: `charge:${this._opIndex}:${task.id}`,
      taskId: task.id,
      project: projectName,
      amount: cost,
    });
    return null;
  }

  _correct(op) {
    const task = this.tasks.get(op.taskId);
    if (!task) return 'E_UNKNOWN_TASK';
    if (task.status !== 'queued') return 'E_INVALID_STATE';
    const v = op.volume;
    if (!Number.isFinite(v) || v <= 0) return 'E_INVALID_VOLUME';
    const oldWells = this.wellsNeeded(task.volume);
    const newWells = this.wellsNeeded(v);
    if (newWells > this.availableWells() + oldWells) return 'E_VOLUME_EXCEEDS_PLATE';
    const project = this.projects.get(task.project);
    const delta = (v - task.volume) * this.config.costPerUnit;
    if (delta > 0 && project.budget < delta) return 'E_BUDGET_NEGATIVE';
    project.budget -= delta;
    this.usedWells += newWells - oldWells;
    this.opStack.push({ kind: 'correct', taskId: task.id, oldVolume: task.volume, delta });
    if (delta !== 0) {
      this._emit(delta > 0 ? 'charge' : 'refund', {
        id: `correct:${this._opIndex}:${task.id}`,
        taskId: task.id,
        project: project.name,
        amount: delta,
      });
    }
    task.volume = v;
    task.cost = v * this.config.costPerUnit;
    return null;
  }

  _budget(op) {
    if (typeof op.project !== 'string' || !op.project) return 'E_INVALID_OP';
    if (!Number.isFinite(op.set)) return 'E_INVALID_OP';
    if (op.set < 0) return 'E_BUDGET_NEGATIVE';
    const project = this._project(op.project);
    const oldBudget = project.budget;
    project.budget = op.set;
    this.opStack.push({ kind: 'budget', project: project.name, oldBudget });
    this._emit('budget', { project: project.name, oldBudget, newBudget: op.set });
    return null;
  }

  _abort(op, now, rt) {
    const task = this.tasks.get(op.taskId);
    if (!task) return 'E_UNKNOWN_TASK';
    if (task.status !== 'queued' && task.status !== 'running') return 'E_INVALID_STATE';
    if (task.status === 'running' && rt) rt.abortRunning(task, now);
    task.status = 'aborted';
    task.channel = null;
    const wells = this.wellsNeeded(task.volume);
    this.usedWells -= wells;
    this.contaminatedWells += wells;
    this.opStack.push({ kind: 'abort', taskId: task.id });
    this._emit('abort', { taskId: task.id, contaminatedWells: wells, time: now });
    return null;
  }

  _undo() {
    const rec = this.opStack.pop();
    if (!rec) return 'E_NO_UNDO';
    switch (rec.kind) {
      case 'enqueue': {
        const task = this.tasks.get(rec.taskId);
        if (!task) return 'E_UNKNOWN_TASK';
        if (task.status === 'running') {
          this.opStack.push(rec);
          return 'E_TASK_RUNNING';
        }
        if (task.status !== 'queued') {
          this.opStack.push(rec);
          return 'E_INVALID_STATE';
        }
        this.usedWells -= this.wellsNeeded(task.volume);
        this.tasks.delete(rec.taskId);
        this.projects.get(rec.project).budget += rec.cost;
        this._emit('refund', {
          id: `undo:${this._opIndex}:${rec.taskId}`,
          taskId: rec.taskId,
          project: rec.project,
          amount: rec.cost,
        });
        return null;
      }
      case 'correct': {
        const task = this.tasks.get(rec.taskId);
        if (!task) return 'E_UNKNOWN_TASK';
        if (task.status !== 'queued') {
          this.opStack.push(rec);
          return task.status === 'running' ? 'E_TASK_RUNNING' : 'E_INVALID_STATE';
        }
        const project = this.projects.get(task.project);
        if (project.budget + rec.delta < 0) {
          this.opStack.push(rec);
          return 'E_BUDGET_NEGATIVE';
        }
        const restoredWells = this.wellsNeeded(rec.oldVolume);
        const currentWells = this.wellsNeeded(task.volume);
        if (restoredWells > this.availableWells() + currentWells) {
          this.opStack.push(rec);
          return 'E_VOLUME_EXCEEDS_PLATE';
        }
        this.usedWells += restoredWells - currentWells;
        project.budget += rec.delta;
        task.volume = rec.oldVolume;
        task.cost = rec.oldVolume * this.config.costPerUnit;
        this._emit('budget', {
          project: project.name,
          oldBudget: project.budget - rec.delta,
          newBudget: project.budget,
        });
        return null;
      }
      case 'budget': {
        const project = this.projects.get(rec.project);
        const prev = project.budget;
        project.budget = rec.oldBudget;
        this._emit('budget', { project: project.name, oldBudget: prev, newBudget: rec.oldBudget });
        return null;
      }
      case 'abort':
        // Confirmed contaminated wells must never be resurrected.
        return 'E_CONTAMINATED_REVIVE';
      default:
        return 'E_UNKNOWN_OP';
    }
  }
}
