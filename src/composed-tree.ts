import {
  normalizeSnapshotInput,
  type CanonicalNode,
  type CanonicalSnapshot,
} from "./canonical.js";
import { SnapshotValidationError } from "./errors.js";
import { matchesQuery, normalizeQuery } from "./query.js";
import type {
  ComposedEdgeKind,
  ComposedNode,
  LocateQuery,
  LocateResult,
  LocatorPath,
  PathStep,
  Revision,
  SnapshotInput,
} from "./types.js";

interface EdgeReference {
  readonly id: string;
  readonly label: string;
}

function fail(
  code: ConstructorParameters<typeof SnapshotValidationError>[0],
  message: string,
  nodeIds: readonly string[],
  slotIds: readonly string[] = [],
): never {
  throw new SnapshotValidationError(code, message, { nodeIds, slotIds });
}

function assertKnown(
  snapshot: CanonicalSnapshot,
  id: string,
  label: string,
): void {
  if (!snapshot.nodes.has(id)) {
    fail("UNKNOWN_NODE", `${label} refers to unknown node "${id}".`, [id]);
  }
}

/**
 * Validate the complete version before any of it is exposed. This checks
 * references, structural uniqueness, duplicate slot assignment, and cycles.
 */
export function validateCanonicalSnapshot(
  snapshot: CanonicalSnapshot,
): void {
  for (const rootId of snapshot.roots) {
    assertKnown(snapshot, rootId, "Root");
  }

  for (const record of snapshot.nodes.values()) {
    for (const childId of record.children) {
      assertKnown(snapshot, childId, `Light child of "${record.id}"`);
    }
    for (const childId of record.shadowRoot?.children ?? []) {
      assertKnown(snapshot, childId, `Shadow child of "${record.id}"`);
    }
    for (const assignedId of record.slot?.assignedNodes ?? []) {
      assertKnown(snapshot, assignedId, `Slot "${record.id}" assignment`);
    }
  }

  const rootIds = new Set<string>();
  for (const rootId of snapshot.roots) {
    if (rootIds.has(rootId)) {
      fail(
        "DUPLICATE_NODE",
        `Node "${rootId}" is listed as a root more than once.`,
        [rootId],
      );
    }
    rootIds.add(rootId);
  }

  const structuralParent = new Map<string, string>();
  const claim = (parentId: string, childId: string, label: string): void => {
    if (rootIds.has(childId)) {
      fail(
        "DUPLICATE_NODE",
        `Node "${childId}" is both a root and a ${label} of "${parentId}".`,
        [childId, parentId],
      );
    }
    const existing = structuralParent.get(childId);
    if (existing !== undefined) {
      fail(
        "DUPLICATE_NODE",
        `Node "${childId}" occurs in more than one structural location ("${existing}" and "${parentId}").`,
        [childId, existing, parentId],
      );
    }
    structuralParent.set(childId, parentId);
  };

  for (const record of snapshot.nodes.values()) {
    for (const childId of record.children) {
      claim(record.id, childId, "light child");
    }
    for (const childId of record.shadowRoot?.children ?? []) {
      claim(record.id, childId, "shadow child");
    }
  }

  for (const rootId of snapshot.roots) {
    if (structuralParent.has(rootId)) {
      fail(
        "DUPLICATE_NODE",
        `Root "${rootId}" also occurs as a structural child of "${structuralParent.get(rootId)}".`,
        [rootId, structuralParent.get(rootId) as string],
      );
    }
  }

  const assignmentOwner = new Map<string, string>();
  for (const record of snapshot.nodes.values()) {
    if (record.slot === undefined) continue;
    for (const assignedId of record.slot.assignedNodes) {
      const existing = assignmentOwner.get(assignedId);
      if (existing !== undefined) {
        fail(
          "DUPLICATE_ASSIGNMENT",
          `Node "${assignedId}" is assigned more than once (slots "${existing}" and "${record.id}").`,
          [assignedId],
          [existing, record.id],
        );
      }
      assignmentOwner.set(assignedId, record.id);
    }
  }

  const edgesFor = (record: CanonicalNode): EdgeReference[] => {
    const edges: EdgeReference[] = [];
    for (const childId of record.children) {
      edges.push({ id: childId, label: `light child of "${record.id}"` });
    }
    for (const childId of record.shadowRoot?.children ?? []) {
      edges.push({ id: childId, label: `shadow child of "${record.id}"` });
    }
    for (const assignedId of record.slot?.assignedNodes ?? []) {
      edges.push({
        id: assignedId,
        label: `assignment of slot "${record.id}"`,
      });
    }
    return edges;
  };

  // A complete, iterative three-color DFS catches cycles in reachable nodes as
  // well as cycles that only exist among orphaned snapshot records.
  const gray = 1;
  const black = 2;
  const color = new Map<string, 1 | 2>();
  const starts = [
    ...snapshot.roots,
    ...[...snapshot.nodes.keys()].filter(
      (id) => !snapshot.roots.includes(id),
    ),
  ];

  for (const start of starts) {
    if (color.has(start)) continue;
    const frames: Array<{
      id: string;
      edges: EdgeReference[];
      next: number;
    }> = [];
    color.set(start, gray);
    frames.push({
      id: start,
      edges: edgesFor(snapshot.nodes.get(start) as CanonicalNode),
      next: 0,
    });

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame.next >= frame.edges.length) {
        color.set(frame.id, black);
        frames.pop();
        continue;
      }
      const edge = frame.edges[frame.next];
      frame.next += 1;
      const state = color.get(edge.id);
      if (state === black) continue;
      if (state === gray) {
        const cycleStart = frames.findIndex((item) => item.id === edge.id);
        const cycleIds = [
          ...frames.slice(cycleStart).map((item) => item.id),
          edge.id,
        ];
        fail(
          "CYCLE",
          `Cycle detected through ${edge.label}: ${cycleIds.join(" -> ")}.`,
          cycleIds,
        );
      }
      color.set(edge.id, gray);
      frames.push({
        id: edge.id,
        edges: edgesFor(snapshot.nodes.get(edge.id) as CanonicalNode),
        next: 0,
      });
    }
  }
}

interface RenderContext {
  readonly seen: Set<string>;
  readonly active: Set<string>;
  readonly byId: Map<string, ComposedNode>;
  readonly nodes: ComposedNode[];
}

interface RenderLocation {
  readonly visibleParentId: string | null;
  readonly parentPath?: LocatorPath;
}

interface MutableComposedNode extends ComposedNode {
  childIds: string[];
}

function makePath(
  kind: ComposedEdgeKind,
  nodeId: string,
  location: RenderLocation,
  slotId?: string,
): LocatorPath {
  const nodeIds = [...(location.parentPath?.nodeIds ?? []), nodeId];
  const step: PathStep = Object.freeze({
    kind,
    nodeId,
    ...(location.visibleParentId !== null
      ? { parentId: location.visibleParentId }
      : {}),
    ...(slotId !== undefined ? { slotId } : {}),
  });
  return Object.freeze({
    nodeIds: Object.freeze(nodeIds),
    steps: Object.freeze([
      ...(location.parentPath?.steps ?? []),
      step,
    ]),
  });
}

function renderNode(
  snapshot: CanonicalSnapshot,
  context: RenderContext,
  id: string,
  kind: ComposedEdgeKind,
  location: RenderLocation,
  slotId?: string,
): ComposedNode | undefined {
  const record = snapshot.nodes.get(id);
  if (record === undefined) {
    fail("UNKNOWN_NODE", `Unknown node "${id}" during composition.`, [id]);
  }
  if (context.active.has(id)) {
    fail("CYCLE", `Cycle while composing node "${id}".`, [id]);
  }
  if (context.seen.has(id)) {
    fail(
      "DUPLICATE_NODE",
      `Node "${id}" would appear more than once in the composed tree.`,
      [id],
    );
  }

  context.seen.add(id);
  context.active.add(id);

  if (record.slot !== undefined) {
    // Slots are transparent placeholders. They are never queryable and never
    // consume a visible path step.
    if (record.slot.assignedNodes.length > 0) {
      for (const assignedId of record.slot.assignedNodes) {
        renderNode(
          snapshot,
          context,
          assignedId,
          "slot-assigned",
          location,
          record.id,
        );
      }
    } else {
      for (const childId of record.children) {
        renderNode(
          snapshot,
          context,
          childId,
          "slot-fallback",
          location,
          record.id,
        );
      }
    }
    context.active.delete(id);
    return undefined;
  }

  const path = makePath(kind, id, location, slotId);
  const node: MutableComposedNode = {
    id,
    role: record.role,
    name: record.name,
    parentId: location.visibleParentId,
    childIds: [],
    depth: path.nodeIds.length - 1,
    via: kind,
    ...(slotId !== undefined ? { slotId } : {}),
    path,
  };
  context.nodes.push(node);
  context.byId.set(id, node);

  const childLocation: RenderLocation = {
    visibleParentId: id,
    parentPath: path,
  };
  if (record.shadowRoot !== undefined) {
    if (record.shadowRoot.mode === "open") {
      for (const childId of record.shadowRoot.children) {
        const child = renderNode(
          snapshot,
          context,
          childId,
          "shadow",
          childLocation,
        );
        if (child !== undefined) node.childIds.push(child.id);
      }
    }
    // A closed shadow root is deliberately opaque: neither its shadow children
    // nor the host's light children are traversed.
  } else {
    for (const childId of record.children) {
      const child = renderNode(
        snapshot,
        context,
        childId,
        "light",
        childLocation,
      );
      if (child !== undefined) node.childIds.push(child.id);
    }
  }

  context.active.delete(id);
  return node;
}

export class ComposedTreeVersion {
  readonly revision: Revision | undefined;
  readonly roots: readonly ComposedNode[];
  readonly nodes: readonly ComposedNode[];
  readonly byId: ReadonlyMap<string, ComposedNode>;

  constructor(
    revision: Revision | undefined,
    roots: readonly ComposedNode[],
    nodes: readonly ComposedNode[],
    byId: ReadonlyMap<string, ComposedNode>,
  ) {
    this.revision = revision;
    this.roots = roots;
    this.nodes = nodes;
    this.byId = byId;
  }

  get rootIds(): readonly string[] {
    return Object.freeze(this.roots.map((node) => node.id));
  }

  get(id: string): ComposedNode | undefined {
    return this.byId.get(id);
  }

  findAll(query: LocateQuery | string, name?: string): readonly ComposedNode[] {
    const normalized = normalizeQuery(query, name);
    return Object.freeze(
      this.nodes.filter((node) => matchesQuery(node, normalized)),
    );
  }

  locate(query: LocateQuery | string, name?: string): LocateResult {
    const normalized = normalizeQuery(query, name);
    const candidates = this.nodes.filter((node) =>
      matchesQuery(node, normalized),
    );
    if (candidates.length === 0) {
      return Object.freeze({
        status: "not-found" as const,
        query: normalized,
        matchCount: 0 as const,
        candidates: Object.freeze([]) as readonly [],
      });
    }
    if (candidates.length === 1) {
      const node = candidates[0];
      return Object.freeze({
        status: "found" as const,
        query: normalized,
        matchCount: 1 as const,
        node,
        path: node.path,
        candidates: Object.freeze([node]),
      });
    }
    return Object.freeze({
      status: "ambiguous" as const,
      query: normalized,
      matchCount: candidates.length,
      candidates: Object.freeze(candidates),
    });
  }

  resolvePath(
    path: LocatorPath | readonly string[] | string | null | undefined,
  ): ComposedNode | undefined {
    if (path === null || path === undefined) return undefined;
    let targetId: string | undefined;
    if (typeof path === "string") {
      targetId = path;
    } else if (Array.isArray(path)) {
      targetId = path[path.length - 1];
    } else {
      const nodeIds = (path as LocatorPath).nodeIds;
      targetId = nodeIds[nodeIds.length - 1];
    }
    return targetId === undefined ? undefined : this.byId.get(targetId);
  }
}

function freezeComposedNode(node: ComposedNode): ComposedNode {
  const mutable = node as MutableComposedNode;
  Object.freeze(mutable.childIds);
  return Object.freeze(mutable);
}

export function buildComposedTreeFromCanonical(
  snapshot: CanonicalSnapshot,
): ComposedTreeVersion {
  validateCanonicalSnapshot(snapshot);

  const context: RenderContext = {
    seen: new Set(),
    active: new Set(),
    byId: new Map(),
    nodes: [],
  };

  for (const rootId of snapshot.roots) {
    renderNode(
      snapshot,
      context,
      rootId,
      "root",
      { visibleParentId: null },
    );
  }

  const nodes = context.nodes.map(freezeComposedNode);
  const roots = Object.freeze(
    nodes.filter((node) => node.parentId === null),
  );
  return new ComposedTreeVersion(
    snapshot.revision,
    roots,
    Object.freeze(nodes),
    context.byId,
  );
}

export function buildComposedTree(input: SnapshotInput): ComposedTreeVersion {
  return buildComposedTreeFromCanonical(normalizeSnapshotInput(input));
}
