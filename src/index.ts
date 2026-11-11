export type PathSegment = string | number;
export type Path = readonly PathSegment[];

export type PatchOperation =
  | { readonly kind: "merge"; readonly value: Record<string, unknown> }
  | { readonly kind: "insert"; readonly index: number; readonly items: readonly unknown[] };

export interface ChildRef {
  readonly id: string;
  readonly seq: number;
}

export interface Patch {
  readonly id: string;
  readonly parentId: string | null;
  readonly path: Path;
  readonly op: PatchOperation;
  readonly children?: readonly ChildRef[];
}

export interface MissingDependency {
  readonly id: string;
  readonly reason: string;
}

export class PatchConflictError extends Error {
  readonly patchId: string;
  constructor(patchId: string) {
    super(`conflicting contents received for patch id "${patchId}"`);
    this.name = "PatchConflictError";
    this.patchId = patchId;
  }
}

export class MissingDependencyError extends Error {
  readonly missing: readonly MissingDependency[];
  constructor(missing: readonly MissingDependency[]) {
    super(
      `cannot finalize: unresolved patch dependencies: ${missing
        .map((entry) => `"${entry.id}" (${entry.reason})`)
        .join("; ")}`,
    );
    this.name = "MissingDependencyError";
    this.missing = missing;
  }
}

export class PatchProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchProtocolError";
  }
}

export interface ResultAssemblerOptions {
  onVersion?: (version: unknown, patchId: string | null) => void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepClone(item)) as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = deepClone(item);
    }
    return out as T;
  }
  return value;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]))
    );
  }
  return false;
}

function mergeObjects(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? mergeObjects(existing, value) : value;
  }
  return out;
}

function applyOperation(target: unknown, op: PatchOperation): unknown {
  switch (op.kind) {
    case "merge": {
      if (!isPlainObject(target)) {
        throw new PatchProtocolError("merge operation target is not an object");
      }
      return mergeObjects(target, op.value);
    }
    case "insert": {
      if (!Array.isArray(target)) {
        throw new PatchProtocolError("insert operation target is not an array");
      }
      if (op.index > target.length) {
        throw new PatchProtocolError(
          `insert index ${op.index} is out of bounds for array of length ${target.length}`,
        );
      }
      return [...target.slice(0, op.index), ...op.items, ...target.slice(op.index)];
    }
  }
}

function applyAtPath(node: unknown, path: Path, op: PatchOperation): unknown {
  if (path.length === 0) {
    return applyOperation(node, op);
  }
  const [head, ...rest] = path;
  if (Array.isArray(node)) {
    if (typeof head !== "number" || !Number.isInteger(head) || head < 0 || head >= node.length) {
      throw new PatchProtocolError(
        `path segment ${JSON.stringify(head)} does not resolve in array of length ${node.length}`,
      );
    }
    const copy = node.slice();
    copy[head] = applyAtPath(node[head], rest, op);
    return copy;
  }
  if (isPlainObject(node)) {
    if (typeof head !== "string" || !Object.prototype.hasOwnProperty.call(node, head)) {
      throw new PatchProtocolError(`path segment ${JSON.stringify(head)} does not resolve in object`);
    }
    return { ...node, [head]: applyAtPath(node[head], rest, op) };
  }
  throw new PatchProtocolError("path does not resolve through a non-container value");
}

function validatePatch(patch: Patch): void {
  if (typeof patch.id !== "string" || patch.id.length === 0) {
    throw new PatchProtocolError("patch id must be a non-empty string");
  }
  if (patch.parentId !== null && typeof patch.parentId !== "string") {
    throw new PatchProtocolError(`patch "${patch.id}": parentId must be a string or null`);
  }
  if (patch.parentId === patch.id) {
    throw new PatchProtocolError(`patch "${patch.id}" cannot be its own parent`);
  }
  if (
    !Array.isArray(patch.path) ||
    !patch.path.every(
      (segment) =>
        typeof segment === "string" || (typeof segment === "number" && Number.isInteger(segment) && segment >= 0),
    )
  ) {
    throw new PatchProtocolError(`patch "${patch.id}": path must be an array of strings and non-negative integers`);
  }
  const op = patch.op;
  if (!isPlainObject(op)) {
    throw new PatchProtocolError(`patch "${patch.id}": missing operation`);
  }
  if (op.kind === "merge") {
    if (!isPlainObject(op.value)) {
      throw new PatchProtocolError(`patch "${patch.id}": merge value must be an object`);
    }
  } else if (op.kind === "insert") {
    if (!Number.isInteger(op.index) || op.index < 0) {
      throw new PatchProtocolError(`patch "${patch.id}": insert index must be a non-negative integer`);
    }
    if (!Array.isArray(op.items)) {
      throw new PatchProtocolError(`patch "${patch.id}": insert items must be an array`);
    }
  } else {
    throw new PatchProtocolError(
      `patch "${patch.id}": unknown operation kind ${JSON.stringify((op as { kind: unknown }).kind)}`,
    );
  }
  if (patch.children !== undefined) {
    if (!Array.isArray(patch.children)) {
      throw new PatchProtocolError(`patch "${patch.id}": children must be an array`);
    }
    const ids = new Set<string>();
    const seqs = new Set<number>();
    for (const child of patch.children) {
      if (typeof child.id !== "string" || child.id.length === 0) {
        throw new PatchProtocolError(`patch "${patch.id}": child references must have a non-empty id`);
      }
      if (!Number.isInteger(child.seq)) {
        throw new PatchProtocolError(`patch "${patch.id}": child "${child.id}" seq must be an integer`);
      }
      if (child.id === patch.id) {
        throw new PatchProtocolError(`patch "${patch.id}" cannot declare itself as a child`);
      }
      if (ids.has(child.id)) {
        throw new PatchProtocolError(`patch "${patch.id}": duplicate child id "${child.id}"`);
      }
      if (seqs.has(child.seq)) {
        throw new PatchProtocolError(`patch "${patch.id}": duplicate child seq ${child.seq}`);
      }
      ids.add(child.id);
      seqs.add(child.seq);
    }
  }
}

/**
 * Assembles an immutable result tree from an initial tree plus a stream of
 * patches produced by GraphQL deferred fields and streaming lists.
 *
 * Semantics:
 * - A patch becomes applicable once its parent patch has been applied; root
 *   patches (parentId === null) apply in arrival order.
 * - A parent patch declares its children with sequence numbers. Sibling
 *   patches are held until every declared sibling has arrived, then applied
 *   in ascending seq order, so list insert positions are interpreted against
 *   the version produced by the completed parent.
 * - Receiving a different payload for an already known patch id raises
 *   PatchConflictError; identical redelivery is a no-op.
 * - Every completed version is deeply frozen; callers only ever observe
 *   immutable snapshots.
 * - finalize() throws MissingDependencyError if any patch is still pending
 *   or any declared child never arrived.
 */
export class ResultAssembler {
  #current: unknown;
  #versions: unknown[] = [];
  #records = new Map<string, Patch>();
  #pending = new Map<string, Patch>();
  #applied = new Set<string>();
  #declarations = new Map<string, readonly ChildRef[]>();
  #frozenNodes = new WeakSet<object>();
  #onVersion: ((version: unknown, patchId: string | null) => void) | undefined;
  #finalized = false;

  constructor(initialTree: unknown, options: ResultAssemblerOptions = {}) {
    this.#current = this.#freeze(deepClone(initialTree));
    this.#versions.push(this.#current);
    this.#onVersion = options.onVersion;
  }

  get current(): unknown {
    return this.#current;
  }

  get versions(): readonly unknown[] {
    return this.#versions.slice();
  }

  pendingIds(): string[] {
    return [...this.#pending.keys()];
  }

  addPatch(patch: Patch): void {
    if (this.#finalized) {
      throw new PatchProtocolError("assembler has been finalized");
    }
    const existing = this.#records.get(patch.id);
    if (existing !== undefined) {
      if (!deepEqual(existing, patch)) {
        throw new PatchConflictError(patch.id);
      }
      return;
    }
    const copy = deepClone(patch);
    validatePatch(copy);
    const declaration = copy.parentId === null ? undefined : this.#declarations.get(copy.parentId);
    if (declaration !== undefined && !declaration.some((child) => child.id === copy.id)) {
      throw new PatchProtocolError(
        `patch "${copy.id}" is not declared as a child of its parent "${copy.parentId}"`,
      );
    }
    this.#records.set(copy.id, copy);
    this.#pending.set(copy.id, copy);
    this.#drain();
  }

  finalize(): unknown {
    this.#finalized = true;
    const missing: MissingDependency[] = [];
    for (const [parentId, children] of this.#declarations) {
      for (const child of children) {
        if (!this.#records.has(child.id)) {
          missing.push({ id: child.id, reason: `declared by "${parentId}" but never received` });
        }
      }
    }
    for (const patch of this.#pending.values()) {
      if (patch.parentId !== null && !this.#records.has(patch.parentId)) {
        missing.push({ id: patch.id, reason: `parent patch "${patch.parentId}" never received` });
      } else {
        missing.push({ id: patch.id, reason: "dependencies incomplete" });
      }
    }
    if (missing.length > 0) {
      throw new MissingDependencyError(missing);
    }
    return this.#current;
  }

  #drain(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const patch of [...this.#pending.values()]) {
        if (patch.parentId === null) {
          this.#apply(patch);
          progressed = true;
        }
      }
      for (const [parentId, children] of this.#declarations) {
        if (!children.every((child) => this.#records.has(child.id))) {
          continue;
        }
        const ordered = [...children].sort((left, right) => left.seq - right.seq);
        for (const child of ordered) {
          const patch = this.#pending.get(child.id);
          if (patch === undefined) {
            continue;
          }
          if (patch.parentId !== parentId) {
            throw new PatchProtocolError(
              `patch "${patch.id}" is declared as a child of "${parentId}" but names parent "${patch.parentId}"`,
            );
          }
          this.#apply(patch);
          progressed = true;
        }
      }
    }
  }

  #apply(patch: Patch): void {
    const children = patch.children ?? [];
    for (const queued of this.#pending.values()) {
      if (queued.parentId === patch.id && !children.some((child) => child.id === queued.id)) {
        throw new PatchProtocolError(
          `patch "${queued.id}" is not declared as a child of its parent "${patch.id}"`,
        );
      }
    }
    this.#current = this.#freeze(applyAtPath(this.#current, patch.path, patch.op));
    this.#pending.delete(patch.id);
    this.#applied.add(patch.id);
    this.#declarations.set(patch.id, children);
    this.#versions.push(this.#current);
    this.#onVersion?.(this.#current, patch.id);
  }

  #freeze(node: unknown): unknown {
    if (!isPlainObject(node) && !Array.isArray(node)) {
      return node;
    }
    const target = node as object;
    if (this.#frozenNodes.has(target)) {
      return node;
    }
    this.#frozenNodes.add(target);
    for (const value of Object.values(node)) {
      this.#freeze(value);
    }
    Object.freeze(target);
    return node;
  }
}
