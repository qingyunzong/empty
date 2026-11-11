import { SnapshotValidationError } from "./errors.js";
import type {
  DocumentTree,
  Revision,
  SerializedSnapshot,
  SnapshotInput,
  SnapshotNodeData,
  TreeNode,
} from "./types.js";

export interface CanonicalShadowRoot {
  readonly mode: "open" | "closed";
  readonly children: readonly string[];
}

export interface CanonicalSlot {
  readonly name: string;
  readonly assignedNodes: readonly string[];
}

export interface CanonicalNode {
  readonly id: string;
  readonly role: string;
  readonly name: string;
  readonly children: readonly string[];
  readonly shadowRoot?: CanonicalShadowRoot;
  readonly slot?: CanonicalSlot;
}

export interface CanonicalSnapshot {
  readonly roots: readonly string[];
  readonly nodes: ReadonlyMap<string, CanonicalNode>;
  readonly revision?: Revision;
}

interface MutableCanonicalNode {
  id: string;
  role: string;
  name: string;
  children: string[];
  shadowRoot?: { mode: "open" | "closed"; children: string[] };
  slot?: { name: string; assignedNodes: string[] };
}

function invalid(message: string, nodeIds: readonly string[] = []): never {
  throw new SnapshotValidationError("INVALID_SNAPSHOT", message, { nodeIds });
}

function assertStringArray(
  value: unknown,
  field: string,
  nodeId: string,
): asserts value is readonly string[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    invalid(`Node "${nodeId}" has a non-array ${field}.`, [nodeId]);
  }
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      invalid(`Node "${nodeId}" has an invalid id in ${field}.`, [nodeId]);
    }
  }
}

function assertNode(value: unknown, label: string): asserts value is TreeNode {
  if (typeof value !== "object" || value === null) {
    invalid(`${label} must be an object.`);
  }
}

function normalizeNested(document: DocumentTree): CanonicalSnapshot {
  if (document.roots !== undefined && !Array.isArray(document.roots)) {
    invalid("Document roots must be an array.");
  }
  if (document.root !== undefined && document.roots !== undefined) {
    invalid("Provide either document.root or document.roots, not both.");
  }
  const roots = document.roots
    ? [...document.roots]
    : document.root
      ? [document.root]
      : [];
  const objectIds = new WeakMap<object, string>();
  const mutableRecords = new Map<string, MutableCanonicalNode>();
  const rootIds: string[] = [];

  const register = (value: unknown, label: string): string => {
    assertNode(value, label);
    const previous = objectIds.get(value);
    if (previous !== undefined) {
      return previous;
    }

    const id = (value as { id?: unknown }).id;
    const role = (value as { role?: unknown }).role;
    if (typeof id !== "string" || id.length === 0) {
      invalid(`${label} must have a non-empty string id.`);
    }
    if (mutableRecords.has(id)) {
      throw new SnapshotValidationError(
        "DUPLICATE_NODE",
        `Node id "${id}" is used by more than one node object.`,
        { nodeIds: [id] },
      );
    }
    if (typeof role !== "string") {
      invalid(`Node "${id}" must have a string role.`, [id]);
    }

    const name = (value as { name?: unknown }).name;
    if (name !== undefined && typeof name !== "string") {
      invalid(`Node "${id}" has a non-string name.`, [id]);
    }

    const kind = (value as { kind?: unknown }).kind;
    if (kind !== undefined && kind !== "element" && kind !== "slot") {
      invalid(`Node "${id}" has an invalid kind.`, [id]);
    }

    const record: MutableCanonicalNode = {
      id,
      role,
      name: name ?? "",
      children: [],
    };
    mutableRecords.set(id, record);
    objectIds.set(value, id);

    const children = (value as { children?: unknown }).children;
    if (children !== undefined && !Array.isArray(children)) {
      invalid(`Node "${id}" has a non-array children field.`, [id]);
    }
    if (Array.isArray(children)) {
      for (let index = 0; index < children.length; index += 1) {
        record.children.push(
          register(children[index], `Node "${id}" child ${index}`),
        );
      }
    }

    const shadowRoot = (value as { shadowRoot?: unknown }).shadowRoot;
    if (shadowRoot !== undefined) {
      if (typeof shadowRoot !== "object" || shadowRoot === null) {
        invalid(`Node "${id}" has an invalid shadow root.`, [id]);
      }
      const mode = (shadowRoot as { mode?: unknown }).mode;
      if (mode !== "open" && mode !== "closed") {
        invalid(`Shadow root of "${id}" must have mode open or closed.`, [id]);
      }
      const shadowChildren = (shadowRoot as { children?: unknown }).children;
      if (shadowChildren !== undefined && !Array.isArray(shadowChildren)) {
        invalid(`Shadow root of "${id}" has non-array children.`, [id]);
      }
      const shadowIds: string[] = [];
      if (Array.isArray(shadowChildren)) {
        for (let index = 0; index < shadowChildren.length; index += 1) {
          shadowIds.push(
            register(
              shadowChildren[index],
              `Shadow child ${index} of "${id}"`,
            ),
          );
        }
      }
      record.shadowRoot = { mode, children: shadowIds };
    }

    const slotDescriptor = (value as { slot?: unknown }).slot;
    const isSlot = kind === "slot" || slotDescriptor !== undefined;
    if (isSlot) {
      if (
        slotDescriptor !== undefined &&
        (typeof slotDescriptor !== "object" || slotDescriptor === null)
      ) {
        invalid(`Slot descriptor of "${id}" is invalid.`, [id]);
      }
      const slot = (slotDescriptor ?? {}) as {
        name?: unknown;
        assignedNodes?: unknown;
        assigned?: unknown;
      };
      if (slot.name !== undefined && typeof slot.name !== "string") {
        invalid(`Slot "${id}" has a non-string name.`, [id]);
      }
      const assignedValue =
        slot.assignedNodes !== undefined ? slot.assignedNodes : slot.assigned;
      if (assignedValue !== undefined && !Array.isArray(assignedValue)) {
        invalid(`Slot "${id}" has non-array assignedNodes.`, [id]);
      }
      const assignedIds: string[] = [];
      if (Array.isArray(assignedValue)) {
        for (let index = 0; index < assignedValue.length; index += 1) {
          assignedIds.push(
            register(
              assignedValue[index],
              `Assigned node ${index} of slot "${id}"`,
            ),
          );
        }
      }
      record.slot = {
        name: (slot.name as string | undefined) ?? "",
        assignedNodes: assignedIds,
      };
    }

    return id;
  };

  for (let index = 0; index < roots.length; index += 1) {
    rootIds.push(register(roots[index], `Root ${index}`));
  }

  const records = new Map<string, CanonicalNode>();
  for (const [id, record] of mutableRecords) {
    const shadowRoot = record.shadowRoot
      ? Object.freeze({
          mode: record.shadowRoot.mode,
          children: Object.freeze([...record.shadowRoot.children]),
        })
      : undefined;
    const slot = record.slot
      ? Object.freeze({
          name: record.slot.name,
          assignedNodes: Object.freeze([...record.slot.assignedNodes]),
        })
      : undefined;
    records.set(
      id,
      Object.freeze({
        id,
        role: record.role,
        name: record.name,
        children: Object.freeze([...record.children]),
        ...(shadowRoot ? { shadowRoot } : {}),
        ...(slot ? { slot } : {}),
      }),
    );
  }

  return {
    roots: Object.freeze(rootIds),
    nodes: records,
    ...(document.revision !== undefined
      ? { revision: document.revision }
      : document.version !== undefined
        ? { revision: document.version }
        : {}),
  };
}

function normalizeSerialized(snapshot: SerializedSnapshot): CanonicalSnapshot {
  if (
    snapshot.nodes === null ||
    typeof snapshot.nodes !== "object"
  ) {
    invalid("Snapshot nodes must be an object map or an array.");
  }
  if (!Array.isArray(snapshot.roots)) {
    invalid("Snapshot roots must be an array.");
  }
  for (const rootId of snapshot.roots) {
    if (typeof rootId !== "string" || rootId.length === 0) {
      invalid("Snapshot roots must contain non-empty string ids.");
    }
  }

  const records = new Map<string, CanonicalNode>();
  const entries: Array<[string | undefined, SnapshotNodeData]> = Array.isArray(
    snapshot.nodes,
  )
    ? snapshot.nodes.map((node) => [undefined, node] as const)
    : Object.entries(snapshot.nodes);

  for (const [key, data] of entries) {
    if (typeof data !== "object" || data === null) {
      invalid("Snapshot contains a non-object node.");
    }
    const id = data.id ?? key;
    if (typeof id !== "string" || id.length === 0) {
      invalid("Snapshot node must have a non-empty id or map key.");
    }
    if (key !== undefined && data.id !== undefined && data.id !== key) {
      invalid(`Node id "${data.id}" does not match map key "${key}".`, [id]);
    }
    if (typeof data.role !== "string") {
      invalid(`Node "${id}" must have a string role.`, [id]);
    }
    if (data.name !== undefined && typeof data.name !== "string") {
      invalid(`Node "${id}" has a non-string name.`, [id]);
    }
    if (records.has(id)) {
      throw new SnapshotValidationError(
        "DUPLICATE_NODE",
        `Node id "${id}" occurs more than once in the snapshot.`,
        { nodeIds: [id] },
      );
    }
    if (
      data.kind !== undefined &&
      data.kind !== "element" &&
      data.kind !== "slot"
    ) {
      invalid(`Node "${id}" has an invalid kind.`, [id]);
    }
    assertStringArray(data.children, "children", id);

    let shadowRoot: CanonicalShadowRoot | undefined;
    if (data.shadowRoot !== undefined) {
      if (typeof data.shadowRoot !== "object" || data.shadowRoot === null) {
        invalid(`Node "${id}" has an invalid shadow root.`, [id]);
      }
      if (
        data.shadowRoot.mode !== "open" &&
        data.shadowRoot.mode !== "closed"
      ) {
        invalid(`Shadow root of "${id}" must have mode open or closed.`, [id]);
      }
      assertStringArray(
        data.shadowRoot.children,
        "shadowRoot.children",
        id,
      );
      shadowRoot = Object.freeze({
        mode: data.shadowRoot.mode,
        children: Object.freeze([...(data.shadowRoot.children ?? [])]),
      });
    }

    let slot: CanonicalSlot | undefined;
    if (data.kind === "slot" || data.slot !== undefined) {
      if (
        data.slot !== undefined &&
        (typeof data.slot !== "object" || data.slot === null)
      ) {
        invalid(`Slot descriptor of "${id}" is invalid.`, [id]);
      }
      if (data.slot?.name !== undefined && typeof data.slot.name !== "string") {
        invalid(`Slot "${id}" has a non-string name.`, [id]);
      }
      const assigned =
        data.slot?.assignedNodes !== undefined
          ? data.slot.assignedNodes
          : data.slot?.assigned;
      assertStringArray(assigned, "slot.assignedNodes", id);
      slot = Object.freeze({
        name: data.slot?.name ?? "",
        assignedNodes: Object.freeze([...(assigned ?? [])]),
      });
    }

    records.set(
      id,
      Object.freeze({
        id,
        role: data.role,
        name: data.name ?? "",
        children: Object.freeze([...(data.children ?? [])]),
        ...(shadowRoot ? { shadowRoot } : {}),
        ...(slot ? { slot } : {}),
      }),
    );
  }

  return {
    roots: Object.freeze([...snapshot.roots]),
    nodes: records,
    ...(snapshot.revision !== undefined
      ? { revision: snapshot.revision }
      : snapshot.version !== undefined
        ? { revision: snapshot.version }
        : {}),
  };
}

export function normalizeSnapshotInput(input: SnapshotInput): CanonicalSnapshot {
  if (Array.isArray(input)) {
    return normalizeNested({ roots: input });
  }
  if (typeof input !== "object" || input === null) {
    invalid("Snapshot input must be a document tree, node, or node array.");
  }
  if (
    "nodes" in input &&
    "roots" in input &&
    typeof (input as { nodes?: unknown }).nodes === "object"
  ) {
    return normalizeSerialized(input as SerializedSnapshot);
  }
  if ("roots" in input || "root" in input) {
    return normalizeNested(input as DocumentTree);
  }
  if ("id" in input && "role" in input) {
    return normalizeNested({ roots: [input as TreeNode] });
  }
  invalid("Unable to recognize the snapshot input shape.");
}
