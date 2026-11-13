import type { DomNode } from "./model.ts";

/** FNV-1a 64-bit over UTF-16 code units; deterministic across runs and platforms. */
export function fnv1a64(input: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

function field(parts: string[], value: string): void {
  parts.push(value.length.toString(36), ":", value, ",");
}

function writeNode(node: DomNode, parts: string[]): void {
  field(parts, node.tag);
  field(parts, node.text ?? "");
  const names = [...node.attributes.keys()].sort();
  parts.push(names.length.toString(36), "[");
  for (const name of names) {
    field(parts, name);
    field(parts, node.attributes.get(name)!);
  }
  parts.push("]");
  parts.push(node.children.length.toString(36), "(");
  for (const child of node.children) writeNode(child, parts);
  parts.push(")");
  if (node.shadowRoot) {
    parts.push("S");
    writeNode(node.shadowRoot, parts);
  } else {
    parts.push("s");
  }
}

/**
 * Canonical serialization: attributes are sorted, children keep document
 * order, shadow roots are included. Two trees with equal canonical form
 * always produce the same hash regardless of how they were constructed.
 */
export function canonicalSerialize(node: DomNode): string {
  const parts: string[] = [];
  writeNode(node, parts);
  return parts.join("");
}

export function hashDom(root: DomNode): string {
  return fnv1a64(canonicalSerialize(root));
}
