export type AXValue = string | number | boolean;

export interface AXNodeInput {
  backendNodeId: number;
  role?: string;
  name?: string;
  ignored?: boolean;
  childIds?: number[];
  properties?: Record<string, AXValue>;
}

export interface AXNode {
  readonly backendNodeId: number;
  readonly role: string;
  readonly name: string;
  readonly ignored: boolean;
  readonly childIds: readonly number[];
  readonly parentId: number | null;
  readonly properties: Readonly<Record<string, AXValue>>;
}

export interface AXNodeChange {
  id: number;
  before: AXNode;
  after: AXNode;
}

export interface AXReparent {
  id: number;
  fromEffectiveParentId: number | null;
  toEffectiveParentId: number | null;
}

export interface AXTreeDiff {
  fromVersion: number;
  toVersion: number;
  added: number[];
  removed: number[];
  changed: AXNodeChange[];
  reparented: AXReparent[];
}

interface BuiltTree {
  nodes: Map<number, AXNode>;
  rootId: number;
}

function normalizeNode(input: AXNodeInput): AXNode {
  return Object.freeze({
    backendNodeId: input.backendNodeId,
    role: input.role ?? "none",
    name: input.name ?? "",
    ignored: input.ignored ?? false,
    childIds: Object.freeze([...(input.childIds ?? [])]),
    parentId: null,
    properties: Object.freeze({ ...(input.properties ?? {}) }),
  });
}

function buildTree(
  inputs: Iterable<AXNodeInput>,
  options: { pruneDetachedFromRoot?: number } = {},
): BuiltTree {
  const draft = new Map<number, AXNode>();
  for (const input of inputs) {
    if (draft.has(input.backendNodeId)) {
      throw new Error(`duplicate backendNodeId ${input.backendNodeId}`);
    }
    draft.set(input.backendNodeId, normalizeNode(input));
  }
  const parentOf = new Map<number, number>();
  for (const node of draft.values()) {
    for (const childId of node.childIds) {
      if (!draft.has(childId)) {
        throw new Error(
          `node ${node.backendNodeId} references unknown child ${childId}`,
        );
      }
      if (parentOf.has(childId)) {
        throw new Error(`node ${childId} has multiple parents`);
      }
      parentOf.set(childId, node.backendNodeId);
    }
  }
  let rootId: number;
  if (options.pruneDetachedFromRoot !== undefined) {
    rootId = options.pruneDetachedFromRoot;
    if (!draft.has(rootId)) {
      throw new Error(`root node ${rootId} is missing from updates`);
    }
    parentOf.delete(rootId);
  } else {
    const rootIds = [...draft.keys()].filter((id) => !parentOf.has(id));
    if (rootIds.length !== 1) {
      throw new Error(`expected exactly one root, found ${rootIds.length}`);
    }
    rootId = rootIds[0];
  }
  const reachable = new Set<number>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (reachable.has(id)) {
      throw new Error(`cycle detected at node ${id}`);
    }
    reachable.add(id);
    for (const childId of draft.get(id)!.childIds) {
      stack.push(childId);
    }
  }
  const nodes = new Map<number, AXNode>();
  for (const node of draft.values()) {
    if (!reachable.has(node.backendNodeId)) {
      if (options.pruneDetachedFromRoot === undefined) {
        throw new Error(`node ${node.backendNodeId} is detached from the tree`);
      }
      continue;
    }
    const parentId =
      node.backendNodeId === rootId
        ? null
        : (parentOf.get(node.backendNodeId) ?? null);
    nodes.set(node.backendNodeId, Object.freeze({ ...node, parentId }));
  }
  return { nodes, rootId };
}

function sameNode(a: AXNode, b: AXNode): boolean {
  if (
    a.role !== b.role ||
    a.name !== b.name ||
    a.ignored !== b.ignored ||
    a.parentId !== b.parentId ||
    a.childIds.length !== b.childIds.length
  ) {
    return false;
  }
  for (let i = 0; i < a.childIds.length; i += 1) {
    if (a.childIds[i] !== b.childIds[i]) return false;
  }
  const aKeys = Object.keys(a.properties);
  const bKeys = Object.keys(b.properties);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a.properties[key] === b.properties[key]);
}

export class AXSnapshot {
  readonly version: number;
  readonly documentEpoch: number;
  readonly rootId: number;
  private readonly nodes: ReadonlyMap<number, AXNode>;
  private readonly effectiveParentCache = new Map<number, number | null>();

  constructor(
    version: number,
    documentEpoch: number,
    rootId: number,
    nodes: Map<number, AXNode>,
  ) {
    this.version = version;
    this.documentEpoch = documentEpoch;
    this.rootId = rootId;
    this.nodes = nodes;
  }

  get size(): number {
    return this.nodes.size;
  }

  has(id: number): boolean {
    return this.nodes.has(id);
  }

  getNode(id: number): AXNode | undefined {
    return this.nodes.get(id);
  }

  childIds(id: number): readonly number[] {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`unknown node ${id} in version ${this.version}`);
    return node.childIds;
  }

  effectiveParentId(id: number): number | null {
    if (this.effectiveParentCache.has(id)) {
      return this.effectiveParentCache.get(id)!;
    }
    const node = this.nodes.get(id);
    if (!node) throw new Error(`unknown node ${id} in version ${this.version}`);
    let cursor = node.parentId;
    while (cursor !== null) {
      const parent = this.nodes.get(cursor)!;
      if (!parent.ignored) break;
      cursor = parent.parentId;
    }
    this.effectiveParentCache.set(id, cursor);
    return cursor;
  }

  effectiveChildren(id: number): AXNode[] {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`unknown node ${id} in version ${this.version}`);
    const result: AXNode[] = [];
    const visit = (current: AXNode): void => {
      for (const childId of current.childIds) {
        const child = this.nodes.get(childId)!;
        if (child.ignored) {
          visit(child);
        } else {
          result.push(child);
        }
      }
    };
    visit(node);
    return result;
  }

  find(predicate: (node: AXNode) => boolean): AXNode[] {
    const result: AXNode[] = [];
    for (const node of this.nodes.values()) {
      if (predicate(node)) result.push(node);
    }
    return result;
  }

  subtreeIds(id: number): number[] {
    const node = this.nodes.get(id);
    if (!node) throw new Error(`unknown node ${id} in version ${this.version}`);
    const result: number[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop()!;
      result.push(current);
      for (const childId of this.nodes.get(current)!.childIds) {
        stack.push(childId);
      }
    }
    return result;
  }

  toJSON(): unknown {
    const emit = (id: number): unknown => {
      const node = this.nodes.get(id)!;
      return {
        backendNodeId: node.backendNodeId,
        role: node.role,
        name: node.name,
        ignored: node.ignored,
        properties: node.properties,
        children: node.childIds.map((childId) => emit(childId)),
      };
    };
    return {
      version: this.version,
      documentEpoch: this.documentEpoch,
      root: emit(this.rootId),
    };
  }
}

export class AXTreeStore {
  private epoch = 0;
  private versionCounter = 0;
  private documentId: string | null = null;
  private readonly retiredIds = new Set<number>();
  private current: BuiltTree | null = null;
  private readonly snapshots = new Map<number, AXSnapshot>();

  get latestVersion(): number {
    return this.versionCounter;
  }

  get currentDocumentId(): string | null {
    return this.documentId;
  }

  private assertUsableIds(inputs: Iterable<AXNodeInput>): void {
    for (const input of inputs) {
      if (this.retiredIds.has(input.backendNodeId)) {
        throw new Error(
          `backendNodeId ${input.backendNodeId} was retired by a previous document and cannot be reused`,
        );
      }
    }
  }

  private commit(tree: BuiltTree): AXSnapshot {
    this.versionCounter += 1;
    const snapshot = new AXSnapshot(
      this.versionCounter,
      this.epoch,
      tree.rootId,
      tree.nodes,
    );
    this.snapshots.set(snapshot.version, snapshot);
    this.current = tree;
    return snapshot;
  }

  loadDocument(documentId: string, inputs: AXNodeInput[]): AXSnapshot {
    if (this.current) {
      for (const id of this.current.nodes.keys()) {
        this.retiredIds.add(id);
      }
    }
    this.assertUsableIds(inputs);
    this.epoch += 1;
    this.documentId = documentId;
    return this.commit(buildTree(inputs));
  }

  applyUpdates(updates: AXNodeInput[]): {
    snapshot: AXSnapshot;
    diff: AXTreeDiff;
  } {
    if (!this.current) {
      throw new Error("applyUpdates requires a loaded document");
    }
    const currentNodes = this.current.nodes;
    this.assertUsableIds(updates.filter((u) => !currentNodes.has(u.backendNodeId)));
    const merged = new Map<number, AXNodeInput>();
    for (const node of currentNodes.values()) {
      merged.set(node.backendNodeId, {
        backendNodeId: node.backendNodeId,
        role: node.role,
        name: node.name,
        ignored: node.ignored,
        childIds: [...node.childIds],
        properties: { ...node.properties },
      });
    }
    for (const update of updates) {
      const previous = merged.get(update.backendNodeId);
      merged.set(update.backendNodeId, {
        backendNodeId: update.backendNodeId,
        role: update.role ?? previous?.role,
        name: update.name ?? previous?.name,
        ignored: update.ignored ?? previous?.ignored,
        childIds:
          update.childIds ??
          (previous?.childIds ? [...previous.childIds] : undefined),
        properties:
          update.properties ??
          (previous ? { ...previous.properties } : undefined),
      });
    }
    const before = this.getSnapshot();
    const snapshot = this.commit(
      buildTree(merged.values(), {
        pruneDetachedFromRoot: this.current.rootId,
      }),
    );
    return { snapshot, diff: diffSnapshots(before, snapshot) };
  }

  getSnapshot(version?: number): AXSnapshot {
    const target = version ?? this.versionCounter;
    const snapshot = this.snapshots.get(target);
    if (!snapshot) throw new Error(`unknown version ${target}`);
    return snapshot;
  }

  diff(fromVersion: number, toVersion: number): AXTreeDiff {
    return diffSnapshots(
      this.getSnapshot(fromVersion),
      this.getSnapshot(toVersion),
    );
  }
}

export function diffSnapshots(
  before: AXSnapshot,
  after: AXSnapshot,
): AXTreeDiff {
  const added: number[] = [];
  const removed: number[] = [];
  const changed: AXNodeChange[] = [];
  const reparented: AXReparent[] = [];

  const afterIds = collectIds(after);
  const beforeIds = collectIds(before);

  for (const id of afterIds) {
    const next = after.getNode(id)!;
    const prev = before.getNode(id);
    if (!prev) {
      added.push(id);
    } else if (!sameNode(prev, next)) {
      changed.push({ id, before: prev, after: next });
    }
  }
  for (const id of beforeIds) {
    if (!after.has(id)) removed.push(id);
  }
  for (const id of afterIds) {
    if (!before.has(id)) continue;
    const fromParent = before.effectiveParentId(id);
    const toParent = after.effectiveParentId(id);
    if (fromParent !== toParent) {
      reparented.push({
        id,
        fromEffectiveParentId: fromParent,
        toEffectiveParentId: toParent,
      });
    }
  }
  return {
    fromVersion: before.version,
    toVersion: after.version,
    added,
    removed,
    changed,
    reparented,
  };
}

function collectIds(snapshot: AXSnapshot): number[] {
  return snapshot.subtreeIds(snapshot.rootId).sort((a, b) => a - b);
}
