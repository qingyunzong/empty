import { parseExpression } from './parser.js';
import {
  ScopeError,
  deepestScope,
  pathToScope,
  findBindingInPath,
} from './scope.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    if (value instanceof Map) {
      for (const v of value.values()) deepFreeze(v);
    } else {
      for (const v of Object.values(value)) deepFreeze(v);
    }
    Object.freeze(value);
  }
  return value;
}

function treeToJSON(node) {
  return {
    id: node.id,
    name: node.name,
    bindings: [...node.bindings.values()].map((b) => ({ name: b.name, kind: b.kind, expr: b.expr })),
    children: node.children.map(treeToJSON),
  };
}

function treeFromJSON(json) {
  const node = { id: json.id, name: json.name, bindings: new Map(), children: json.children.map(treeFromJSON) };
  for (const b of json.bindings) {
    node.bindings.set(b.name, { name: b.name, kind: b.kind, expr: b.expr });
  }
  return node;
}

// Copy-on-write replace of the nearest visible binding of `name`.
// Only scopes on the root-to-target path are copied; every other subtree is shared.
function applyPatch(tree, patch) {
  const start = deepestScope(tree);
  const path = pathToScope(tree, start.id);
  const found = findBindingInPath(path, patch.name);
  if (!found) {
    throw new ScopeError(`cannot correct undefined binding '${patch.name}'`);
  }
  const onPath = new Set(pathToScope(tree, found.scope.id).map((s) => s.id));
  const rebuild = (node) => {
    if (!onPath.has(node.id)) return node;
    let bindings = node.bindings;
    if (node.id === found.scope.id) {
      bindings = new Map(node.bindings);
      bindings.set(patch.name, { name: patch.name, kind: 'corrected', expr: patch.expr });
    }
    return { id: node.id, name: node.name, bindings, children: node.children.map(rebuild) };
  };
  return rebuild(tree);
}

// Append-only store of immutable snapshots. The base snapshot stores a full
// tree; every `correct` stores only a delta { parent, patch }, so parent and
// child versions coexist and parents are never mutated.
export class SnapshotStore {
  constructor() {
    this.records = new Map(); // version -> { version, parent, tree? , patch? }
    this.cache = new Map();   // version -> materialized frozen tree
    this.nextVersion = 1;
  }

  commit(rootScope) {
    const version = this.nextVersion++;
    this.records.set(version, { version, parent: null, tree: treeToJSON(rootScope) });
    return version;
  }

  correct(version, name, exprSource) {
    const tree = this.materialize(version); // validates that the parent exists
    const start = deepestScope(tree);
    const path = pathToScope(tree, start.id);
    if (!findBindingInPath(path, name)) {
      throw new ScopeError(`cannot correct undefined binding '${name}'`);
    }
    const expr = parseExpression(exprSource);
    const newVersion = this.nextVersion++;
    this.records.set(newVersion, { version: newVersion, parent: version, patch: { name, expr } });
    return newVersion;
  }

  materialize(version) {
    if (this.cache.has(version)) return this.cache.get(version);
    const rec = this.records.get(version);
    if (!rec) throw new ScopeError(`unknown snapshot version ${version}`);
    const tree = rec.parent === null
      ? treeFromJSON(rec.tree)
      : applyPatch(this.materialize(rec.parent), rec.patch);
    deepFreeze(tree);
    this.cache.set(version, tree);
    return tree;
  }

  versions() {
    return [...this.records.keys()];
  }

  toJSON() {
    return {
      nextVersion: this.nextVersion,
      snapshots: [...this.records.values()],
    };
  }

  static fromJSON(data) {
    const store = new SnapshotStore();
    store.nextVersion = data.nextVersion;
    for (const rec of data.snapshots) store.records.set(rec.version, rec);
    return store;
  }
}
