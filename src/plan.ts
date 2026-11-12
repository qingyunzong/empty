import {
  compareUtf8,
  inputFingerprint,
} from './canonical.ts';
import { JoinEngineError, type JoinErrorCode } from './errors.ts';
import type { Atom, JoinInput, JoinPlan } from './types.ts';

function fail(code: JoinErrorCode, message: string): never {
  throw new JoinEngineError(code, message);
}

function validateAtom(atom: unknown, path: string): Atom {
  if (typeof atom === 'bigint') {
    return atom;
  }
  if (typeof atom === 'string') {
    return atom;
  }
  fail('INVALID_ROW_SHAPE', `${path} must be a bigint or a canonical decimal string`);
}

export function buildPlan(input: JoinInput): JoinPlan {
  if (!input || !Array.isArray(input.relations) || input.relations.length === 0) {
    fail('EMPTY_INPUT', 'at least one relation is required');
  }
  if (!Array.isArray(input.edges)) {
    fail('NOT_CONNECTED', 'edges must be an array');
  }

  const relationNames = new Set<string>();
  const attributesByRelation = new Map<string, string[]>();
  const globalAttributeType = new Map<string, 'integer' | 'string'>();

  for (const relation of input.relations) {
    if (typeof relation.name !== 'string' || relation.name.length === 0) {
      fail('INVALID_RELATION_NAME', 'relation names must be non-empty UTF-8 strings');
    }
    if (relationNames.has(relation.name)) {
      fail('DUPLICATE_RELATION_NAME', `duplicate relation name ${relation.name}`);
    }
    relationNames.add(relation.name);

    if (!Array.isArray(relation.attributes)) {
      fail('INVALID_ATTRIBUTE', `relation ${relation.name} requires an attribute list`);
    }
    const attributes: string[] = [];
    const localAttributes = new Set<string>();
    for (const attribute of relation.attributes) {
      if (typeof attribute !== 'string' || attribute.length === 0) {
        fail('INVALID_ATTRIBUTE', `relation ${relation.name} has an invalid attribute name`);
      }
      if (localAttributes.has(attribute)) {
        fail('INVALID_ATTRIBUTE', `relation ${relation.name} declares attribute ${attribute} more than once`);
      }
      localAttributes.add(attribute);
      attributes.push(attribute);
    }
    attributesByRelation.set(relation.name, attributes);

    if (!Array.isArray(relation.rows)) {
      fail('INVALID_ROW_SHAPE', `relation ${relation.name} rows must be an array`);
    }
    for (const [rowIndex, row] of relation.rows.entries()) {
      if (row === null || typeof row !== 'object') {
        fail('INVALID_ROW_SHAPE', `relation ${relation.name} row ${rowIndex} must be an object`);
      }
      const keys = Object.keys(row);
      if (keys.length !== attributes.length || keys.some((key) => !localAttributes.has(key))) {
        fail('INVALID_ROW_SHAPE', `relation ${relation.name} row ${rowIndex} does not match its schema`);
      }
      for (const attribute of attributes) {
        const atom = validateAtom((row as Record<string, unknown>)[attribute],
          `relation ${relation.name} row ${rowIndex} attribute ${attribute}`);
        const domain: 'integer' | 'string' = typeof atom === 'bigint' ? 'integer' : 'string';
        const known = globalAttributeType.get(attribute);
        if (known === undefined) {
          globalAttributeType.set(attribute, domain);
        } else if (known !== domain) {
          fail('TYPE_MISMATCH', `attribute ${attribute} is used with inconsistent domains`);
        }
      }
    }
  }

  const adjacency = new Map<string, Set<string>>();
  for (const name of relationNames) {
    adjacency.set(name, new Set());
  }
  const edgeKeys = new Set<string>();
  for (const edge of input.edges) {
    if (!Array.isArray(edge) || edge.length !== 2) {
      fail('UNKNOWN_EDGE_ENDPOINT', 'each edge must be a pair of relation names');
    }
    const [left, right] = edge;
    if (!relationNames.has(left) || !relationNames.has(right)) {
      fail('UNKNOWN_EDGE_ENDPOINT', `edge ${left} -- ${right} references an unknown relation`);
    }
    if (left === right) {
      fail('SELF_LOOP_EDGE', `self loop on relation ${left} is not a tree edge`);
    }
    const normalized = JSON.stringify(
      compareUtf8(left, right) <= 0 ? [left, right] : [right, left],
    );
    if (edgeKeys.has(normalized)) {
      fail('DUPLICATE_EDGE', `duplicate edge ${left} -- ${right}`);
    }
    edgeKeys.add(normalized);
    adjacency.get(left)!.add(right);
    adjacency.get(right)!.add(left);
  }

  const root = [...relationNames].sort(compareUtf8)[0];
  const parent = new Map<string, string | null>();
  const children = new Map<string, string[]>();
  const preorder: string[] = [];
  for (const name of relationNames) {
    parent.set(name, null);
    children.set(name, []);
  }

  const stack: string[] = [root];
  const seen = new Set<string>([root]);
  while (stack.length > 0) {
    const current = stack.pop()!;
    preorder.push(current);
    const orderedNeighbors = [...adjacency.get(current)!].sort(compareUtf8);
    for (const neighbor of orderedNeighbors) {
      if (neighbor === parent.get(current)) {
        continue;
      }
      if (seen.has(neighbor)) {
        fail('CYCLE_DETECTED', `edge ${current} -- ${neighbor} creates a cycle`);
      }
      seen.add(neighbor);
      parent.set(neighbor, current);
      children.get(current)!.push(neighbor);
      stack.push(neighbor);
    }
  }
  if (seen.size !== relationNames.size) {
    const disconnected = [...relationNames].filter((name) => !seen.has(name)).sort(compareUtf8);
    fail('NOT_CONNECTED', `relations are not connected: ${disconnected.join(', ')}`);
  }

  const postorder: string[] = [];
  const visitPostorder = (node: string): void => {
    for (const child of children.get(node)!) {
      visitPostorder(child);
    }
    postorder.push(node);
  };
  visitPostorder(root);

  for (const [attribute] of globalAttributeType) {
    const holders = [...relationNames].filter((name) =>
      attributesByRelation.get(name)!.includes(attribute),
    );
    if (holders.length <= 1) {
      continue;
    }
    const holderSet = new Set(holders);
    const attributeRoot = holders.sort(compareUtf8)[0];
    const reachable = new Set<string>([attributeRoot]);
    const walkStack = [attributeRoot];
    while (walkStack.length > 0) {
      const current = walkStack.pop()!;
      reachable.add(current);
      for (const neighbor of adjacency.get(current)!) {
        if (holderSet.has(neighbor) && !reachable.has(neighbor)) {
          walkStack.push(neighbor);
        }
      }
    }
    if (reachable.size !== holderSet.size) {
      fail(
        'RUNNING_INTERSECTION_VIOLATION',
        `attribute ${attribute} does not induce a connected subtree`,
      );
    }
  }

  const adjacencyRecord: Record<string, string[]> = {};
  const childrenRecord: Record<string, string[]> = {};
  const parentRecord: Record<string, string | null> = {};
  const attributeRecord: Record<string, string[]> = {};
  for (const name of relationNames) {
    adjacencyRecord[name] = [...adjacency.get(name)!].sort(compareUtf8);
    childrenRecord[name] = children.get(name)!;
    parentRecord[name] = parent.get(name)!;
    attributeRecord[name] = [...attributesByRelation.get(name)!].sort(compareUtf8);
  }

  return {
    relations: [...relationNames].sort(compareUtf8),
    attributes: attributeRecord,
    root,
    parent: parentRecord,
    children: childrenRecord,
    adjacency: adjacencyRecord,
    postorder,
    preorder,
    edges: [...edgeKeys]
      .map((key) => JSON.parse(key) as [string, string])
      .sort(([la, ra], [lb, rb]) => {
        const first = compareUtf8(la, lb);
        return first !== 0 ? first : compareUtf8(ra, rb);
      }),
    digest: inputFingerprint(input),
  };
}
