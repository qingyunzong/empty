'use strict';

const { normalizeProblem, problemToJSON } = require('./model');
const { solve } = require('./solve');
const { minimalInfeasibleSubset } = require('./certificate');

function buildOutput(problem, solution) {
  if (!solution.feasible) {
    return {
      feasible: false,
      certificate: minimalInfeasibleSubset(problemToJSON(problem)),
    };
  }
  const ids = [...problem.tasks.keys()].sort();
  return {
    feasible: true,
    maxLateness: solution.lmax === -Infinity ? null : solution.lmax,
    schedule: ids.map((id) => {
      const task = problem.tasks.get(id);
      const start = solution.starts.get(id);
      return { id, line: task.line, start, end: start + task.duration };
    }),
  };
}

function evaluate(problem) {
  return buildOutput(problem, solve(problem));
}

function applyOpsJSON(problemJSON, ops) {
  const next = structuredClone(problemJSON);
  next.tasks = next.tasks ?? [];
  next.precedence = next.precedence ?? [];
  next.capacity = next.capacity ?? {};
  const direct = new Set();
  const capacityEdits = [];
  for (const op of ops) {
    if (op === null || typeof op !== 'object') throw new Error('edit op must be an object');
    switch (op.op) {
      case 'upsertTask': {
        const task = op.task;
        if (task === null || typeof task !== 'object' || typeof task.id !== 'string') {
          throw new Error('upsertTask requires a task object with an id');
        }
        const index = next.tasks.findIndex((t) => t.id === task.id);
        if (index >= 0) next.tasks[index] = task;
        else next.tasks.push(task);
        direct.add(task.id);
        break;
      }
      case 'deleteTask': {
        if (!next.tasks.some((t) => t.id === op.id)) {
          throw new Error(`deleteTask: unknown task id: ${op.id}`);
        }
        next.tasks = next.tasks.filter((t) => t.id !== op.id);
        next.precedence = next.precedence.filter(([a, b]) => a !== op.id && b !== op.id);
        direct.add(op.id);
        break;
      }
      case 'addPrecedence': {
        if (!next.precedence.some(([a, b]) => a === op.before && b === op.after)) {
          next.precedence.push([op.before, op.after]);
        }
        direct.add(op.before);
        direct.add(op.after);
        break;
      }
      case 'removePrecedence': {
        next.precedence = next.precedence.filter(
          ([a, b]) => !(a === op.before && b === op.after),
        );
        direct.add(op.before);
        direct.add(op.after);
        break;
      }
      case 'setCapacity': {
        if (typeof op.line !== 'string' || op.line.length === 0) {
          throw new Error('setCapacity requires a line');
        }
        const key = op.slot === null || op.slot === undefined ? '*' : String(op.slot);
        next.capacity[op.line] = next.capacity[op.line] ?? {};
        next.capacity[op.line][key] = op.capacity;
        capacityEdits.push({ line: op.line, slot: key });
        break;
      }
      default:
        throw new Error(`unknown edit op: ${op.op}`);
    }
  }
  return { next, direct, capacityEdits };
}

function computeAffected(prevResult, prevProblem, nextProblem, direct, capacityEdits) {
  const affected = new Set(direct);
  if (prevResult.feasible) {
    for (const edit of capacityEdits) {
      for (const op of prevResult.schedule) {
        if (op.line !== edit.line) continue;
        if (edit.slot === '*' || (op.start <= Number(edit.slot) && Number(edit.slot) < op.end)) {
          affected.add(op.id);
        }
      }
    }
  }
  const edges = [...prevProblem.precedence, ...nextProblem.precedence];
  let grew = true;
  while (grew) {
    grew = false;
    for (const [before, after] of edges) {
      if (affected.has(before) && !affected.has(after)) { affected.add(after); grew = true; }
      if (affected.has(after) && !affected.has(before)) { affected.add(before); grew = true; }
    }
  }
  return affected;
}

// Local repair keeps every unaffected task at its previous start and re-solves
// only the affected ones. It "suffices" when the repaired schedule is still a
// global optimum of the new problem.
function tryLocalRepair(prevResult, nextProblem, affected, globalSolution) {
  if (!prevResult.feasible || !globalSolution.feasible) return false;
  const fixed = new Map();
  for (const op of prevResult.schedule) {
    if (!affected.has(op.id) && nextProblem.tasks.has(op.id)) {
      fixed.set(op.id, op.start);
    }
  }
  const local = solve(nextProblem, { fixed });
  if (!local.feasible) return false;
  if (local.lmax !== globalSolution.lmax) return false;
  for (const id of nextProblem.tasks.keys()) {
    if (local.starts.get(id) !== globalSolution.starts.get(id)) return false;
  }
  return true;
}

class Store {
  constructor(problem) {
    this.problem = problem;
    this.result = evaluate(problem);
    this.undoStack = [];
    this.redoStack = [];
  }

  static create(input) {
    return new Store(normalizeProblem(input));
  }

  applyEdit(edit) {
    const ops = Array.isArray(edit?.ops) ? edit.ops : [edit];
    const prevJSON = problemToJSON(this.problem);
    const prevResult = this.result;
    const { next, direct, capacityEdits } = applyOpsJSON(prevJSON, ops);
    const nextProblem = normalizeProblem(next);
    const globalSolution = solve(nextProblem);
    const result = buildOutput(nextProblem, globalSolution);
    const affected = computeAffected(prevResult, this.problem, nextProblem, direct, capacityEdits);
    const localRepair = tryLocalRepair(prevResult, nextProblem, affected, globalSolution);
    this.undoStack.push({ problem: prevJSON, result: prevResult });
    this.redoStack = [];
    this.problem = nextProblem;
    this.result = result;
    return {
      ...result,
      affectedOps: [...affected].sort(),
      localRepair,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
    };
  }

  undo() {
    if (this.undoStack.length === 0) throw new Error('nothing to undo');
    this.redoStack.push({ problem: problemToJSON(this.problem), result: this.result });
    const snapshot = this.undoStack.pop();
    this.problem = normalizeProblem(snapshot.problem);
    this.result = snapshot.result;
    return {
      ...this.result,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
    };
  }

  redo() {
    if (this.redoStack.length === 0) throw new Error('nothing to redo');
    this.undoStack.push({ problem: problemToJSON(this.problem), result: this.result });
    const snapshot = this.redoStack.pop();
    this.problem = normalizeProblem(snapshot.problem);
    this.result = snapshot.result;
    return {
      ...this.result,
      undoDepth: this.undoStack.length,
      redoDepth: this.redoStack.length,
    };
  }

  toJSON() {
    return {
      problem: problemToJSON(this.problem),
      result: this.result,
      undoStack: this.undoStack,
      redoStack: this.redoStack,
    };
  }

  static fromJSON(json) {
    const store = Object.create(Store.prototype);
    store.problem = normalizeProblem(json.problem);
    store.result = json.result;
    store.undoStack = json.undoStack ?? [];
    store.redoStack = json.redoStack ?? [];
    return store;
  }
}

module.exports = { Store, evaluate, applyOpsJSON, computeAffected, tryLocalRepair };
