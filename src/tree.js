export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function isInt(value) {
  return Number.isInteger(value);
}

export function buildTree(tenants) {
  if (!Array.isArray(tenants) || tenants.length === 0) {
    throw new ValidationError('INVALID_CONFIG', 'tenants must be a non-empty array');
  }

  const nodes = new Map();
  for (const tenant of tenants) {
    if (!tenant || typeof tenant.id !== 'string' || tenant.id.length === 0) {
      throw new ValidationError('INVALID_TENANT', 'every tenant needs a non-empty string id');
    }
    if (nodes.has(tenant.id)) {
      throw new ValidationError('DUPLICATE_TENANT', `duplicate tenant id: ${tenant.id}`);
    }
    nodes.set(tenant.id, {
      id: tenant.id,
      parentId: tenant.parent ?? null,
      children: [],
      guarantee: null,
      capacity: null,
      baseLimit: 0,
      used: 0,
      lentOut: 0,
      borrowedIn: 0,
    });
  }

  const roots = [...nodes.values()].filter((node) => node.parentId === null);
  if (roots.length === 0) {
    throw new ValidationError('NO_ROOT', 'exactly one root tenant (parent: null) is required');
  }
  if (roots.length > 1) {
    throw new ValidationError('MULTIPLE_ROOTS', `expected exactly one root, found: ${roots.map((n) => n.id).join(', ')}`);
  }
  const root = roots[0];

  for (const tenant of tenants) {
    const node = nodes.get(tenant.id);
    if (node.parentId !== null && !nodes.has(node.parentId)) {
      throw new ValidationError('MISSING_PARENT', `tenant ${tenant.id} references missing parent ${node.parentId}`);
    }
    if (node === root) {
      if (!isInt(tenant.capacity)) {
        throw new ValidationError('INVALID_QUOTA', `root ${tenant.id} requires an integer capacity`);
      }
      if (tenant.capacity < 0) {
        throw new ValidationError('NEGATIVE_QUOTA', `root ${tenant.id} has negative capacity ${tenant.capacity}`);
      }
      node.capacity = tenant.capacity;
      node.baseLimit = tenant.capacity;
    } else {
      if (!isInt(tenant.guarantee)) {
        throw new ValidationError('INVALID_QUOTA', `tenant ${tenant.id} requires an integer guarantee`);
      }
      if (tenant.guarantee < 0) {
        throw new ValidationError('NEGATIVE_QUOTA', `tenant ${tenant.id} has negative guarantee ${tenant.guarantee}`);
      }
      node.guarantee = tenant.guarantee;
      node.baseLimit = tenant.guarantee;
    }
  }

  for (const id of nodes.keys()) {
    const seen = new Set();
    let cursor = id;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new ValidationError('CYCLE', `tenant tree contains a cycle involving ${cursor}`);
      }
      seen.add(cursor);
      cursor = nodes.get(cursor).parentId;
    }
  }

  for (const node of nodes.values()) {
    if (node.parentId !== null) {
      nodes.get(node.parentId).children.push(node.id);
    }
  }

  for (const node of nodes.values()) {
    const childSum = node.children.reduce((sum, childId) => sum + nodes.get(childId).guarantee, 0);
    if (childSum > node.baseLimit) {
      if (node === root) {
        throw new ValidationError(
          'ROOT_CAP_EXCEEDED',
          `children guarantees (${childSum}) exceed root capacity (${node.baseLimit})`,
        );
      }
      throw new ValidationError(
        'PARENT_CAP_EXCEEDED',
        `children guarantees (${childSum}) exceed guarantee of ${node.id} (${node.baseLimit})`,
      );
    }
  }

  const paths = new Map();
  const ancestors = new Map();
  for (const id of nodes.keys()) {
    const path = [];
    const ancestorSet = new Set();
    let cursor = id;
    while (cursor !== null) {
      path.push(cursor);
      if (cursor !== id) ancestorSet.add(cursor);
      cursor = nodes.get(cursor).parentId;
    }
    paths.set(id, path);
    ancestors.set(id, ancestorSet);
  }

  return { nodes, rootId: root.id, paths, ancestors };
}
