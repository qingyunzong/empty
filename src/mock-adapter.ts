import {
  normalizeSnapshotInput,
  type CanonicalNode,
  type CanonicalSnapshot,
} from "./canonical.js";
import {
  buildComposedTreeFromCanonical,
  ComposedTreeVersion,
} from "./composed-tree.js";
import { MockAdapterError } from "./errors.js";
import type {
  ComposedNode,
  LocateQuery,
  LocateResult,
  LocatorPath,
  SnapshotInput,
} from "./types.js";

export interface MockNodeInput {
  readonly kind?: "element" | "slot";
  readonly id: string;
  readonly role: string;
  readonly name?: string;
  readonly children?: readonly MockNodeInput[];
  readonly shadowRoot?: {
    readonly mode: "open" | "closed";
    readonly children?: readonly MockNodeInput[];
  };
  readonly slot?: {
    readonly name?: string;
    readonly assignedNodeIds?: readonly string[];
    readonly assigned?: readonly string[];
  };
}

interface MutableAdapterNode {
  id: string;
  role: string;
  name: string;
  children: string[];
  shadowRoot?: { mode: "open" | "closed"; children: string[] };
  slot?: { name: string; assignedNodes: string[] };
}

interface AdapterState {
  roots: string[];
  nodes: Map<string, MutableAdapterNode>;
  revision: number;
}

export type MockBatchOperation =
  | {
      readonly type: "addRoot";
      readonly node: string | MockNodeInput;
    }
  | {
      readonly type: "appendChild";
      readonly parentId: string;
      readonly child: string | MockNodeInput;
    }
  | {
      readonly type: "insertBefore";
      readonly parentId: string;
      readonly child: string | MockNodeInput;
      readonly beforeId: string;
    }
  | {
      readonly type: "reparent";
      readonly nodeId: string;
      readonly parentId: string;
      readonly beforeId?: string;
    }
  | {
      readonly type: "removeNode";
      readonly nodeId: string;
    }
  | {
      readonly type: "detachNode";
      readonly nodeId: string;
    }
  | {
      readonly type: "setName";
      readonly nodeId: string;
      readonly name: string;
    }
  | {
      readonly type: "setRole";
      readonly nodeId: string;
      readonly role: string;
    }
  | {
      readonly type: "attachShadow";
      readonly hostId: string;
      readonly mode: "open" | "closed";
      readonly children?: readonly (string | MockNodeInput)[];
    }
  | {
      readonly type: "setSlotAssignments";
      readonly slotId: string;
      readonly assignedNodeIds: readonly string[];
    }
  | {
      readonly type: "setSlotName";
      readonly slotId: string;
      readonly name: string;
    }
  | {
      readonly type: "clearSlot";
      readonly slotId: string;
    };

function requireNode(
  state: AdapterState,
  id: string,
): MutableAdapterNode {
  const node = state.nodes.get(id);
  if (node === undefined) {
    throw new MockAdapterError(`Unknown mock node "${id}".`);
  }
  return node;
}

function cloneState(state: AdapterState): AdapterState {
  const nodes = new Map<string, MutableAdapterNode>();
  for (const [id, node] of state.nodes) {
    nodes.set(id, {
      id: node.id,
      role: node.role,
      name: node.name,
      children: [...node.children],
      ...(node.shadowRoot
        ? {
            shadowRoot: {
              mode: node.shadowRoot.mode,
              children: [...node.shadowRoot.children],
            },
          }
        : {}),
      ...(node.slot
        ? {
            slot: {
              name: node.slot.name,
              assignedNodes: [...node.slot.assignedNodes],
            },
          }
        : {}),
    });
  }
  return {
    roots: [...state.roots],
    nodes,
    revision: state.revision,
  };
}

function detachFromContainment(state: AdapterState, id: string): void {
  state.roots = state.roots.filter((rootId) => rootId !== id);
  for (const node of state.nodes.values()) {
    node.children = node.children.filter((childId) => childId !== id);
    if (node.shadowRoot) {
      node.shadowRoot.children = node.shadowRoot.children.filter(
        (childId) => childId !== id,
      );
    }
  }
}

function createSubtree(state: AdapterState, input: MockNodeInput): string {
  if (typeof input !== "object" || input === null) {
    throw new MockAdapterError("New mock node must be an object.");
  }
  if (typeof input.id !== "string" || input.id.length === 0) {
    throw new MockAdapterError("New mock node must have a non-empty id.");
  }
  if (state.nodes.has(input.id)) {
    throw new MockAdapterError(
      `Mock node "${input.id}" already exists; use a move operation instead.`,
    );
  }
  if (typeof input.role !== "string") {
    throw new MockAdapterError(`Mock node "${input.id}" has invalid role.`);
  }
  if (input.name !== undefined && typeof input.name !== "string") {
    throw new MockAdapterError(`Mock node "${input.id}" has invalid name.`);
  }
  if (
    input.kind !== undefined &&
    input.kind !== "element" &&
    input.kind !== "slot"
  ) {
    throw new MockAdapterError(`Mock node "${input.id}" has invalid kind.`);
  }

  const node: MutableAdapterNode = {
    id: input.id,
    role: input.role,
    name: input.name ?? "",
    children: [],
  };
  state.nodes.set(input.id, node);

  for (const child of input.children ?? []) {
    node.children.push(createSubtree(state, child));
  }

  if (input.shadowRoot !== undefined) {
    if (
      input.shadowRoot.mode !== "open" &&
      input.shadowRoot.mode !== "closed"
    ) {
      throw new MockAdapterError(
        `Shadow root of "${input.id}" must have mode open or closed.`,
      );
    }
    const children: string[] = [];
    for (const child of input.shadowRoot.children ?? []) {
      children.push(createSubtree(state, child));
    }
    node.shadowRoot = { mode: input.shadowRoot.mode, children };
  }

  if (input.kind === "slot" || input.slot !== undefined) {
    const descriptor = input.slot ?? {};
    const assigned =
      descriptor.assignedNodeIds !== undefined
        ? descriptor.assignedNodeIds
        : descriptor.assigned;
    if (assigned !== undefined && !Array.isArray(assigned)) {
      throw new MockAdapterError(
        `Slot "${input.id}" assignments must be an array.`,
      );
    }
    node.slot = {
      name: descriptor.name ?? "",
      assignedNodes: [...(assigned ?? [])],
    };
  }

  return input.id;
}

function addChild(
  state: AdapterState,
  parentId: string,
  child: string | MockNodeInput,
): string {
  const parent = requireNode(state, parentId);
  const childId =
    typeof child === "string"
      ? requireNode(state, child).id
      : createSubtree(state, child);
  detachFromContainment(state, childId);
  parent.children.push(childId);
  return childId;
}

function canonicalFromState(state: AdapterState): CanonicalSnapshot {
  const records = new Map<string, CanonicalNode>();
  for (const [id, node] of state.nodes) {
    records.set(
      id,
      Object.freeze({
        id,
        role: node.role,
        name: node.name,
        children: Object.freeze([...node.children]),
        ...(node.shadowRoot
          ? {
              shadowRoot: Object.freeze({
                mode: node.shadowRoot.mode,
                children: Object.freeze([...node.shadowRoot.children]),
              }),
            }
          : {}),
        ...(node.slot
          ? {
              slot: Object.freeze({
                name: node.slot.name,
                assignedNodes: Object.freeze([
                  ...node.slot.assignedNodes,
                ]),
              }),
            }
          : {}),
      }),
    );
  }
  return {
    roots: Object.freeze([...state.roots]),
    nodes: records,
    revision: state.revision,
  };
}

function fromCanonical(snapshot: CanonicalSnapshot): AdapterState {
  const nodes = new Map<string, MutableAdapterNode>();
  for (const [id, record] of snapshot.nodes) {
    nodes.set(id, {
      id,
      role: record.role,
      name: record.name,
      children: [...record.children],
      ...(record.shadowRoot
        ? {
            shadowRoot: {
              mode: record.shadowRoot.mode,
              children: [...record.shadowRoot.children],
            },
          }
        : {}),
      ...(record.slot
        ? {
            slot: {
              name: record.slot.name,
              assignedNodes: [...record.slot.assignedNodes],
            },
          }
        : {}),
    });
  }
  return { roots: [...snapshot.roots], nodes, revision: 0 };
}

export class MockTransaction {
  private readonly state: AdapterState;

  constructor(state: AdapterState) {
    this.state = state;
  }

  createNode(input: MockNodeInput): string {
    return createSubtree(this.state, input);
  }

  addRoot(child: string | MockNodeInput): string {
    const childId =
      typeof child === "string"
        ? requireNode(this.state, child).id
        : createSubtree(this.state, child);
    detachFromContainment(this.state, childId);
    this.state.roots.push(childId);
    return childId;
  }

  appendChild(parentId: string, child: string | MockNodeInput): string {
    return addChild(this.state, parentId, child);
  }

  insertBefore(
    parentId: string,
    child: string | MockNodeInput,
    beforeId: string,
  ): string {
    const parent = requireNode(this.state, parentId);
    if (!parent.children.includes(beforeId)) {
      throw new MockAdapterError(
        `Node "${beforeId}" is not a child of "${parentId}".`,
      );
    }
    const childId =
      typeof child === "string"
        ? requireNode(this.state, child).id
        : createSubtree(this.state, child);
    if (childId === beforeId) {
      return childId;
    }
    detachFromContainment(this.state, childId);
    const index = parent.children.indexOf(beforeId);
    if (index < 0) {
      parent.children.push(childId);
    } else {
      parent.children.splice(index, 0, childId);
    }
    return childId;
  }

  reparent(nodeId: string, parentId: string, beforeId?: string): string {
    requireNode(this.state, nodeId);
    return beforeId === undefined
      ? addChild(this.state, parentId, nodeId)
      : this.insertBefore(parentId, nodeId, beforeId);
  }

  detachNode(nodeId: string): void {
    requireNode(this.state, nodeId);
    detachFromContainment(this.state, nodeId);
  }

  removeNode(nodeId: string): void {
    requireNode(this.state, nodeId);
    const doomed = new Set<string>();
    const pending = [nodeId];
    while (pending.length > 0) {
      const id = pending.pop() as string;
      if (doomed.has(id)) continue;
      doomed.add(id);
      const node = this.state.nodes.get(id);
      if (node === undefined) continue;
      pending.push(...node.children);
      pending.push(...(node.shadowRoot?.children ?? []));
    }

    detachFromContainment(this.state, nodeId);
    for (const [id, node] of this.state.nodes) {
      if (doomed.has(id)) continue;
      if (node.slot !== undefined) {
        node.slot.assignedNodes = node.slot.assignedNodes.filter(
          (assignedId) => !doomed.has(assignedId),
        );
      }
    }
    for (const id of doomed) {
      detachFromContainment(this.state, id);
      this.state.nodes.delete(id);
    }
  }

  setAccessibleName(nodeId: string, name: string): void {
    if (typeof name !== "string") {
      throw new MockAdapterError("Accessible name must be a string.");
    }
    requireNode(this.state, nodeId).name = name;
  }

  setRole(nodeId: string, role: string): void {
    if (typeof role !== "string") {
      throw new MockAdapterError("Role must be a string.");
    }
    requireNode(this.state, nodeId).role = role;
  }

  attachShadow(
    hostId: string,
    mode: "open" | "closed",
    children: readonly (string | MockNodeInput)[] = [],
  ): void {
    if (mode !== "open" && mode !== "closed") {
      throw new MockAdapterError("Shadow mode must be open or closed.");
    }
    const host = requireNode(this.state, hostId);
    const childIds: string[] = [];
    for (const child of children) {
      const childId =
        typeof child === "string"
          ? requireNode(this.state, child).id
          : createSubtree(this.state, child);
      detachFromContainment(this.state, childId);
      childIds.push(childId);
    }
    host.shadowRoot = { mode, children: childIds };
  }

  setSlotAssignments(
    slotId: string,
    assignedNodeIds: readonly string[],
  ): void {
    const node = requireNode(this.state, slotId);
    if (!Array.isArray(assignedNodeIds)) {
      throw new MockAdapterError("Slot assignments must be an array.");
    }
    for (const id of assignedNodeIds) {
      requireNode(this.state, id);
    }
    node.slot ??= { name: "", assignedNodes: [] };
    node.slot.assignedNodes = [...assignedNodeIds];
  }

  setSlotName(slotId: string, name: string): void {
    if (typeof name !== "string") {
      throw new MockAdapterError("Slot name must be a string.");
    }
    const node = requireNode(this.state, slotId);
    node.slot ??= { name: "", assignedNodes: [] };
    node.slot.name = name;
  }

  clearSlot(slotId: string): void {
    requireNode(this.state, slotId);
    delete this.state.nodes.get(slotId)?.slot;
  }
}

export class MockBrowserAdapter {
  private state: AdapterState;
  private current: ComposedTreeVersion;

  constructor(input?: SnapshotInput) {
    if (input === undefined) {
      this.state = { roots: [], nodes: new Map(), revision: 0 };
      this.current = buildComposedTreeFromCanonical(
        canonicalFromState(this.state),
      );
      return;
    }
    const canonical = normalizeSnapshotInput(input);
    this.state = fromCanonical(canonical);
    this.state.revision =
      typeof canonical.revision === "number" ? canonical.revision : 0;
    this.current = buildComposedTreeFromCanonical({
      ...canonicalFromState(this.state),
      revision: this.state.revision,
    });
  }

  static from(input: SnapshotInput): MockBrowserAdapter {
    return new MockBrowserAdapter(input);
  }

  get revision(): number {
    return this.state.revision;
  }

  get version(): ComposedTreeVersion {
    return this.current;
  }

  snapshot(): ComposedTreeVersion {
    return this.current;
  }

  getVersion(): ComposedTreeVersion {
    return this.current;
  }

  getRoots(): readonly string[] {
    return this.current.rootIds;
  }

  getNode(nodeId: string): ComposedNode | undefined {
    return this.current.get(nodeId);
  }

  locate(query: LocateQuery | string, name?: string): LocateResult {
    return this.current.locate(query, name);
  }

  findAll(
    query: LocateQuery | string,
    name?: string,
  ): readonly ComposedNode[] {
    return this.current.findAll(query, name);
  }

  resolvePath(
    path: LocatorPath | readonly string[] | string | null | undefined,
  ): ComposedNode | undefined {
    return this.current.resolvePath(path);
  }

  /**
   * Apply all mutations atomically. The previous version remains active when
   * the transaction throws or produces an invalid version.
   */
  batch(mutator: (transaction: MockTransaction) => void): ComposedTreeVersion {
    const draft = cloneState(this.state);
    const nextRevision = this.state.revision + 1;
    draft.revision = nextRevision;
    mutator(new MockTransaction(draft));
    const version = buildComposedTreeFromCanonical(
      canonicalFromState(draft),
    );
    this.state = draft;
    this.current = version;
    return version;
  }

  applyBatch(
    operations: readonly MockBatchOperation[],
  ): ComposedTreeVersion {
    return this.batch((transaction) => {
      for (const operation of operations) {
        switch (operation.type) {
          case "addRoot":
            transaction.addRoot(operation.node);
            break;
          case "appendChild":
            transaction.appendChild(
              operation.parentId,
              operation.child,
            );
            break;
          case "insertBefore":
            transaction.insertBefore(
              operation.parentId,
              operation.child,
              operation.beforeId,
            );
            break;
          case "reparent":
            transaction.reparent(
              operation.nodeId,
              operation.parentId,
              operation.beforeId,
            );
            break;
          case "removeNode":
            transaction.removeNode(operation.nodeId);
            break;
          case "detachNode":
            transaction.detachNode(operation.nodeId);
            break;
          case "setName":
            transaction.setAccessibleName(
              operation.nodeId,
              operation.name,
            );
            break;
          case "setRole":
            transaction.setRole(operation.nodeId, operation.role);
            break;
          case "attachShadow":
            transaction.attachShadow(
              operation.hostId,
              operation.mode,
              operation.children,
            );
            break;
          case "setSlotAssignments":
            transaction.setSlotAssignments(
              operation.slotId,
              operation.assignedNodeIds,
            );
            break;
          case "setSlotName":
            transaction.setSlotName(operation.slotId, operation.name);
            break;
          case "clearSlot":
            transaction.clearSlot(operation.slotId);
            break;
          default: {
            const exhaustive: never = operation;
            throw new MockAdapterError(
              `Unknown batch operation ${JSON.stringify(exhaustive)}.`,
            );
          }
        }
      }
    });
  }
}
