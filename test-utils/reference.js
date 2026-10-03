import { createHash } from 'node:crypto';
import { canonicalJSON } from '../src/canonical.js';

// Independent reference: recompute every hash from scratch (as if the whole
// graph were cleared), resolving dependencies recursively with memoization.
export function fullRecompute(tasks) {
  const memo = new Map();
  const hashOf = (id) => {
    if (memo.has(id)) return memo.get(id);
    const task = tasks.get(id);
    const deps = task.deps
      .map((d) => ({ id: d, hash: hashOf(d) }))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    const hash = createHash('sha256')
      .update(canonicalJSON({ deps, inputHash: task.inputHash, moduleVersion: task.moduleVersion }))
      .digest('hex');
    memo.set(id, hash);
    return hash;
  };
  const out = new Map();
  for (const id of tasks.keys()) out.set(id, hashOf(id));
  return out;
}

// Reference invalidation set: declarations that differ between `before` and
// `after`, plus everything reachable through reverse dependency edges.
export function invalidationClosure(before, after) {
  const changed = new Set();
  for (const [id, task] of after) {
    const old = before.get(id);
    if (
      !old ||
      old.inputHash !== task.inputHash ||
      old.moduleVersion !== task.moduleVersion ||
      old.deps.join(' ') !== task.deps.join(' ')
    ) {
      changed.add(id);
    }
  }
  const dependents = new Map([...after.keys()].map((id) => [id, []]));
  for (const [id, task] of after) {
    for (const dep of task.deps) dependents.get(dep).push(id);
  }
  const closure = new Set(changed);
  const stack = [...changed];
  while (stack.length > 0) {
    for (const dependent of dependents.get(stack.pop())) {
      if (!closure.has(dependent)) {
        closure.add(dependent);
        stack.push(dependent);
      }
    }
  }
  return closure;
}

// Apply ops to a plain declaration map (no hashing), mirroring transaction
// semantics so tests can build the "after" graph independently.
export function applyOpsToDeclarations(tasks, ops) {
  const next = new Map([...tasks].map(([id, t]) => [id, { ...t, deps: [...t.deps] }]));
  for (const op of ops) {
    switch (op.type) {
      case 'setModuleVersion':
        next.get(op.task).moduleVersion = op.moduleVersion ?? '';
        break;
      case 'setInput':
        next.get(op.task).inputHash = op.inputHash ?? '';
        break;
      case 'addDep': {
        const deps = next.get(op.task).deps;
        if (!deps.includes(op.dep)) deps.push(op.dep);
        deps.sort();
        break;
      }
      case 'removeDep': {
        const task = next.get(op.task);
        task.deps = task.deps.filter((d) => d !== op.dep);
        break;
      }
      case 'addTask':
        next.set(op.task, {
          inputHash: op.inputHash ?? '',
          moduleVersion: op.moduleVersion ?? '',
          deps: [...new Set(op.deps ?? [])].sort(),
        });
        break;
      case 'removeTask':
        next.delete(op.task);
        break;
      default:
        throw new Error(`unknown op ${op.type}`);
    }
  }
  return next;
}
