export class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
  }
}

function checkGuarantee(value, id) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError('INVALID_QUOTA', `tenant "${id}": guarantee must be an integer, got ${JSON.stringify(value)}`);
  }
  if (value < 0) {
    throw new ValidationError('NEGATIVE_QUOTA', `tenant "${id}": guarantee must be >= 0, got ${value}`);
  }
}

// Builds the tenant tree and validates all structural / quota rules.
// Each node carries live accounting fields used by the scheduler:
//   usage      - running orders in this subtree (recorded level by level up to root)
//   lentOut    - quota lent by this subtree to tenants outside this subtree
//   borrowedIn - quota borrowed by this subtree from tenants outside this subtree
//   ownLent    - active loan records issued by this tenant itself
// Invariant held at all times: usage(n) <= guarantee(n) - lentOut(n) + borrowedIn(n)
export function buildTree(tenants) {
  if (!Array.isArray(tenants) || tenants.length === 0) {
    throw new ValidationError('NO_TENANTS', 'tenants must be a non-empty array');
  }
  const nodes = new Map();
  for (const t of tenants) {
    if (!t || typeof t.id !== 'string' || t.id.length === 0) {
      throw new ValidationError('INVALID_TENANT', `every tenant needs a non-empty string id: ${JSON.stringify(t)}`);
    }
    if (nodes.has(t.id)) {
      throw new ValidationError('DUPLICATE_TENANT', `duplicate tenant id "${t.id}"`);
    }
    checkGuarantee(t.guarantee, t.id);
    nodes.set(t.id, {
      id: t.id,
      parent: t.parent ?? null,
      guarantee: t.guarantee,
      priority: t.priority ?? 0,
      children: [],
      path: [],
      usage: 0,
      lentOut: 0,
      borrowedIn: 0,
      ownLent: 0,
    });
  }
  for (const n of nodes.values()) {
    if (n.parent !== null && !nodes.has(n.parent)) {
      throw new ValidationError('MISSING_PARENT', `tenant "${n.id}": parent "${n.parent}" does not exist`);
    }
  }
  for (const n of nodes.values()) {
    const seen = new Set();
    let cur = n;
    while (cur) {
      if (seen.has(cur.id)) {
        throw new ValidationError('TENANT_CYCLE', `cycle detected in tenant tree at "${cur.id}"`);
      }
      seen.add(cur.id);
      cur = cur.parent === null ? null : nodes.get(cur.parent);
    }
  }
  const roots = [...nodes.values()].filter((n) => n.parent === null);
  if (roots.length === 0) {
    throw new ValidationError('NO_ROOT', 'tenant tree has no root (exactly one tenant must have parent null)');
  }
  if (roots.length > 1) {
    throw new ValidationError('MULTIPLE_ROOTS', `tenant tree has ${roots.length} roots: ${roots.map((r) => r.id).join(', ')}`);
  }
  const root = roots[0];
  for (const n of nodes.values()) {
    const path = [];
    let cur = n;
    while (cur) {
      path.push(cur);
      cur = cur.parent === null ? null : nodes.get(cur.parent);
    }
    if (path[path.length - 1] !== root) {
      throw new ValidationError('TENANT_CYCLE', `tenant "${n.id}" is not connected to root "${root.id}"`);
    }
    n.path = path; // self .. root
  }
  for (const n of nodes.values()) {
    if (n.parent !== null) nodes.get(n.parent).children.push(n);
  }
  for (const n of nodes.values()) {
    if (n.parent !== null) {
      const p = nodes.get(n.parent);
      if (n.guarantee > p.guarantee) {
        throw new ValidationError(
          'QUOTA_EXCEEDS_PARENT',
          `tenant "${n.id}" guarantee ${n.guarantee} exceeds parent "${p.id}" cap ${p.guarantee}`,
        );
      }
    }
  }
  for (const n of nodes.values()) {
    const sum = n.children.reduce((s, c) => s + c.guarantee, 0);
    if (sum > n.guarantee) {
      throw new ValidationError(
        'CHILDREN_EXCEED_PARENT',
        `children of "${n.id}" sum to ${sum}, exceeding its cap ${n.guarantee}`,
      );
    }
  }
  return { nodes, root };
}
