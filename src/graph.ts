import type {
  JsonApiDocument,
  JsonApiResource,
  ResourceIdentifier,
  SourcePointer,
  SparseFieldsets,
} from "./types.js";

export interface FieldOrigin<T = unknown> {
  value: T;
  source: SourcePointer;
}

export type Linkage = ResourceIdentifier | ResourceIdentifier[] | null;

export interface RelationshipEntry {
  linkage?: FieldOrigin<Linkage>;
  links: Map<string, FieldOrigin>;
  meta: Map<string, FieldOrigin>;
}

export interface ResourceNode {
  type: string;
  id: string;
  attributes: Map<string, FieldOrigin>;
  relationships: Map<string, RelationshipEntry>;
  links: Map<string, FieldOrigin>;
  meta: Map<string, FieldOrigin>;
  /** Where this resource was first seen. */
  source: SourcePointer;
}

export interface MergeOptions {
  /** Explicit generation per document index; defaults to the document index. */
  generations?: number[];
}

function compareSource(a: SourcePointer, b: SourcePointer): number {
  return a.generation - b.generation || a.documentIndex - b.documentIndex;
}

function nodeKey(type: string, id: string): string {
  return `${type} ${id}`;
}

function sortedKeys<V>(map: Map<string, V>): string[] {
  return [...map.keys()].sort();
}

export class ResourceGraph {
  private nodes = new Map<string, ResourceNode>();
  /** Resources skipped because they lack a usable type+id identity. */
  readonly skipped: { resource: JsonApiResource; source: SourcePointer }[] = [];

  get(type: string, id: string): ResourceNode | undefined {
    return this.nodes.get(nodeKey(type, id));
  }

  get size(): number {
    return this.nodes.size;
  }

  /** All nodes in deterministic (type, id) order. */
  list(): ResourceNode[] {
    return [...this.nodes.values()].sort(
      (a, b) =>
        (a.type < b.type ? -1 : a.type > b.type ? 1 : 0) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
  }

  /**
   * Resolve a relationship's linkage to existing nodes. Missing linkage or
   * linkage to unknown resources yields nothing — nodes are never fabricated.
   */
  related(node: ResourceNode, name: string): ResourceNode[] {
    const linkage = node.relationships.get(name)?.linkage?.value;
    if (linkage == null) return [];
    const ids = Array.isArray(linkage) ? linkage : [linkage];
    const out: ResourceNode[] = [];
    for (const ref of ids) {
      const target = this.get(ref.type, ref.id);
      if (target) out.push(target);
    }
    return out;
  }

  /** Breadth-first traversal; safe on cyclic graphs. Deterministic order. */
  reachable(type: string, id: string): ResourceNode[] {
    const start = this.get(type, id);
    if (!start) return [];
    const seen = new Set<string>([nodeKey(type, id)]);
    const queue: ResourceNode[] = [start];
    const out: ResourceNode[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      out.push(current);
      for (const name of sortedKeys(current.relationships)) {
        for (const target of this.related(current, name)) {
          const key = nodeKey(target.type, target.id);
          if (!seen.has(key)) {
            seen.add(key);
            queue.push(target);
          }
        }
      }
    }
    return out;
  }

  /** Provenance of a field: attribute, relationship, or link. */
  fieldSource(type: string, id: string, field: string): SourcePointer | undefined {
    const node = this.get(type, id);
    if (!node) return undefined;
    return (
      node.attributes.get(field)?.source ??
      node.relationships.get(field)?.linkage?.source ??
      node.links.get(field)?.source ??
      node.meta.get(field)?.source
    );
  }

  /** Serialize the graph to a flat JSON:API document in deterministic order. */
  toDocument(options: { fields?: SparseFieldsets } = {}): JsonApiDocument {
    const data = this.list().map((node) => this.serializeNode(node, options.fields));
    return { data };
  }

  private serializeNode(
    node: ResourceNode,
    fields?: SparseFieldsets,
  ): JsonApiResource {
    const allowed = fields?.[node.type] ? new Set(fields[node.type]) : undefined;
    const resource: JsonApiResource = { type: node.type, id: node.id };

    const attributes: Record<string, unknown> = {};
    for (const key of sortedKeys(node.attributes)) {
      if (allowed && !allowed.has(key)) continue;
      attributes[key] = node.attributes.get(key)!.value;
    }
    if (Object.keys(attributes).length > 0) resource.attributes = attributes;

    const relationships: Record<string, unknown> = {};
    for (const name of sortedKeys(node.relationships)) {
      if (allowed && !allowed.has(name)) continue;
      const entry = node.relationships.get(name)!;
      const rel: Record<string, unknown> = {};
      if (entry.linkage) rel.data = entry.linkage.value;
      if (entry.links.size > 0) {
        const links: Record<string, unknown> = {};
        for (const key of sortedKeys(entry.links)) links[key] = entry.links.get(key)!.value;
        rel.links = links;
      }
      if (Object.keys(rel).length > 0) relationships[name] = rel;
    }
    if (Object.keys(relationships).length > 0) {
      resource.relationships = relationships as JsonApiResource["relationships"];
    }

    if (node.links.size > 0) {
      const links: Record<string, unknown> = {};
      for (const key of sortedKeys(node.links)) links[key] = node.links.get(key)!.value;
      resource.links = links;
    }
    return resource;
  }

  /** Merge one resource object into the graph. */
  ingest(resource: JsonApiResource, source: SourcePointer): void {
    if (!resource || typeof resource.type !== "string" || typeof resource.id !== "string") {
      this.skipped.push({ resource, source });
      return;
    }
    const key = nodeKey(resource.type, resource.id);
    let node = this.nodes.get(key);
    if (!node) {
      node = {
        type: resource.type,
        id: resource.id,
        attributes: new Map(),
        relationships: new Map(),
        links: new Map(),
        meta: new Map(),
        source,
      };
      this.nodes.set(key, node);
    }

    const put = (
      map: Map<string, FieldOrigin>,
      field: string,
      value: unknown,
      pointer: string,
    ) => {
      const existing = map.get(field);
      if (!existing || compareSource(existing.source, source) < 0) {
        map.set(field, { value, source: { ...source, pointer } });
      }
    };

    for (const [field, value] of Object.entries(resource.attributes ?? {})) {
      put(node.attributes, field, value, `${source.pointer}/attributes/${field}`);
    }
    for (const [field, value] of Object.entries(resource.links ?? {})) {
      put(node.links, field, value, `${source.pointer}/links/${field}`);
    }
    for (const [field, value] of Object.entries(resource.meta ?? {})) {
      put(node.meta, field, value, `${source.pointer}/meta/${field}`);
    }
    for (const [name, rel] of Object.entries(resource.relationships ?? {})) {
      let entry = node.relationships.get(name);
      if (!entry) {
        entry = { links: new Map(), meta: new Map() };
        node.relationships.set(name, entry);
      }
      const base = `${source.pointer}/relationships/${name}`;
      if (rel && "data" in rel) {
        const existing = entry.linkage;
        if (!existing || compareSource(existing.source, source) < 0) {
          entry.linkage = {
            value: (rel.data ?? null) as Linkage,
            source: { ...source, pointer: `${base}/data` },
          };
        }
      }
      for (const [field, value] of Object.entries(rel?.links ?? {})) {
        put(entry.links, field, value, `${base}/links/${field}`);
      }
      for (const [field, value] of Object.entries(rel?.meta ?? {})) {
        put(entry.meta, field, value, `${base}/meta/${field}`);
      }
    }
  }
}

/** Merge JSON:API documents (primary data + included) into one resource graph. */
export function mergeDocuments(
  documents: JsonApiDocument[],
  options: MergeOptions = {},
): ResourceGraph {
  const graph = new ResourceGraph();
  documents.forEach((doc, documentIndex) => {
    if (!doc) return;
    const generation = options.generations?.[documentIndex] ?? documentIndex;
    const source = (pointer: string): SourcePointer => ({ documentIndex, generation, pointer });
    if (Array.isArray(doc.data)) {
      doc.data.forEach((resource, i) => graph.ingest(resource, source(`/data/${i}`)));
    } else if (doc.data) {
      graph.ingest(doc.data, source("/data"));
    }
    doc.included?.forEach((resource, i) => graph.ingest(resource, source(`/included/${i}`)));
  });
  return graph;
}
