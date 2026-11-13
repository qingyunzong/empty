export type NodeId = number;

/** Serializable description of a DOM subtree, as produced by the scraper. */
export interface NodePayload {
  id: NodeId;
  tag: string;
  attributes?: Record<string, string>;
  text?: string;
  children?: NodePayload[];
  shadowRoot?: NodePayload;
}

/** Incremental mutation events emitted by the structured web scraper. */
export type SnapshotEvent =
  | { type: "insert"; parentId: NodeId; index?: number; node: NodePayload }
  | { type: "remove"; nodeId: NodeId }
  | { type: "attribute"; nodeId: NodeId; name: string; value: string | null }
  | { type: "text"; nodeId: NodeId; text: string }
  | { type: "shadowRoot"; hostId: NodeId; root: NodePayload };

/** Mutable live node maintained by the applier. */
export interface DomNode {
  id: NodeId;
  tag: string;
  attributes: Map<string, string>;
  children: DomNode[];
  text: string | null;
  shadowRoot: DomNode | null;
  parent: DomNode | null;
}

export function buildNode(payload: NodePayload, parent: DomNode | null = null): DomNode {
  const node: DomNode = {
    id: payload.id,
    tag: payload.tag,
    attributes: new Map(Object.entries(payload.attributes ?? {})),
    children: [],
    text: payload.text ?? null,
    shadowRoot: null,
    parent,
  };
  node.children = (payload.children ?? []).map((child) => buildNode(child, node));
  node.shadowRoot = payload.shadowRoot ? buildNode(payload.shadowRoot, node) : null;
  return node;
}

/** Depth-first ids of a subtree, including shadow roots. */
export function collectIds(node: DomNode, out: NodeId[] = []): NodeId[] {
  out.push(node.id);
  for (const child of node.children) collectIds(child, out);
  if (node.shadowRoot) collectIds(node.shadowRoot, out);
  return out;
}

/** Ids appearing anywhere in a payload subtree. */
export function payloadIds(payload: NodePayload, out: NodeId[] = []): NodeId[] {
  out.push(payload.id);
  for (const child of payload.children ?? []) payloadIds(child, out);
  if (payload.shadowRoot) payloadIds(payload.shadowRoot, out);
  return out;
}

/** Ids an event needs to resolve before it can be applied. */
export function referencedIds(event: SnapshotEvent): NodeId[] {
  switch (event.type) {
    case "insert":
      return [event.parentId];
    case "remove":
    case "attribute":
    case "text":
      return [event.nodeId];
    case "shadowRoot":
      return [event.hostId];
  }
}

/** Serialize a live node back to a plain payload (e.g. for snapshot diffs). */
export function toPayload(node: DomNode): NodePayload {
  const payload: NodePayload = { id: node.id, tag: node.tag };
  if (node.attributes.size > 0) payload.attributes = Object.fromEntries(node.attributes);
  if (node.text !== null) payload.text = node.text;
  if (node.children.length > 0) payload.children = node.children.map(toPayload);
  if (node.shadowRoot) payload.shadowRoot = toPayload(node.shadowRoot);
  return payload;
}
