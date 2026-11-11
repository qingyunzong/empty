export type Revision = string | number;

/**
 * A node in the caller-supplied document tree.
 *
 * `children` is the light-DOM (or, for a slot, fallback) child list. A
 * `shadowRoot` replaces that child list in the composed tree. `slot`, when
 * present, marks this node as a transparent slot placeholder.
 */
export interface TreeNode {
  readonly kind?: "element" | "slot";
  /** Stable, document-wide unique identity. */
  readonly id: string;
  readonly role: string;
  /** Caller-provided accessible name. Missing means the empty name. */
  readonly name?: string;
  readonly children?: readonly TreeNode[];
  readonly shadowRoot?: ShadowRootSnapshot;
  readonly slot?: SlotDescriptor;
}

export interface ShadowRootSnapshot {
  readonly mode: "open" | "closed";
  readonly children?: readonly TreeNode[];
}

export interface SlotDescriptor {
  readonly name?: string;
  /**
   * Explicitly assigned nodes. An empty or missing list makes the slot render
   * its fallback children.
   */
  readonly assignedNodes?: readonly TreeNode[];
  /** Alias accepted for convenience. */
  readonly assigned?: readonly TreeNode[];
}

export interface DocumentTree {
  readonly roots?: readonly TreeNode[];
  readonly root?: TreeNode;
  readonly revision?: Revision;
  readonly version?: Revision;
}

/**
 * A serializable form where every edge refers to a node by id. This is useful
 * for RPA recordings, fixtures, and transport across process boundaries.
 */
export interface SnapshotNodeData {
  readonly kind?: "element" | "slot";
  readonly id?: string;
  readonly role: string;
  readonly name?: string;
  readonly children?: readonly string[];
  readonly shadowRoot?: ShadowRootData;
  readonly slot?: SlotData;
}

export interface ShadowRootData {
  readonly mode: "open" | "closed";
  readonly children?: readonly string[];
}

export interface SlotData {
  readonly name?: string;
  readonly assignedNodes?: readonly string[];
  /** Alias accepted for convenience. */
  readonly assigned?: readonly string[];
}

export interface SerializedSnapshot {
  readonly roots: readonly string[];
  readonly nodes:
    | Readonly<Record<string, SnapshotNodeData>>
    | readonly SnapshotNodeData[];
  readonly revision?: Revision;
  readonly version?: Revision;
}

export type SnapshotInput =
  | DocumentTree
  | TreeNode
  | readonly TreeNode[]
  | SerializedSnapshot;

export type ComposedEdgeKind =
  | "root"
  | "light"
  | "shadow"
  | "slot-assigned"
  | "slot-fallback";

/**
 * One hop in a stable path. Paths intentionally contain node identities rather
 * than sibling offsets, so inserting siblings does not invalidate a recording.
 */
export interface PathStep {
  readonly kind: ComposedEdgeKind;
  readonly nodeId: string;
  readonly parentId?: string;
  readonly slotId?: string;
}

export interface LocatorPath {
  /** Visible composed-tree node ids, from root to target. */
  readonly nodeIds: readonly string[];
  readonly steps: readonly PathStep[];
}

export interface ComposedNode {
  readonly id: string;
  readonly role: string;
  /** Normalized accessible name; absent names become "". */
  readonly name: string;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
  readonly depth: number;
  readonly via: ComposedEdgeKind;
  readonly slotId?: string;
  readonly path: LocatorPath;
}

export interface LocateQuery {
  readonly role: string;
  /**
   * Exact accessible-name match. Omit to match any name for the role.
   * `""` explicitly matches nodes with no accessible name.
 */
  readonly name?: string;
}

export interface FoundLocateResult {
  readonly status: "found";
  readonly query: LocateQuery;
  readonly matchCount: 1;
  readonly node: ComposedNode;
  readonly path: LocatorPath;
  readonly candidates: readonly ComposedNode[];
}

export interface NotFoundLocateResult {
  readonly status: "not-found";
  readonly query: LocateQuery;
  readonly matchCount: 0;
  readonly candidates: readonly [];
}

export interface AmbiguousLocateResult {
  readonly status: "ambiguous";
  readonly query: LocateQuery;
  readonly matchCount: number;
  /** All matches, in composed-tree order. Never silently picks one. */
  readonly candidates: readonly ComposedNode[];
}

export type LocateResult =
  | FoundLocateResult
  | NotFoundLocateResult
  | AmbiguousLocateResult;

export type SnapshotErrorCode =
  | "DUPLICATE_NODE"
  | "DUPLICATE_ASSIGNMENT"
  | "CYCLE"
  | "UNKNOWN_NODE"
  | "INVALID_SNAPSHOT";
