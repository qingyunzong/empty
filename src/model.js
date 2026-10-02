import fs from 'node:fs';

export class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}

export const EXIT = Object.freeze({ ROLLBACK: 16, CHAIN: 17, CYCLE: 18 });

export function refOf(recipe, version) {
  return `${recipe}@${version}`;
}

export function loadRecipes(path) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ExitError(1, `cannot read recipes file ${path}: ${err.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ExitError(1, 'recipes file must contain a JSON object');
  }
  if (typeof data.factory !== 'string' || !data.factory) {
    throw new ExitError(1, 'recipes.factory must be a non-empty string');
  }

  const workshops = new Map();
  const reactorToWorkshop = new Map();
  for (const w of data.workshops ?? []) {
    if (workshops.has(w.id)) throw new ExitError(1, `duplicate workshop ${w.id}`);
    workshops.set(w.id, [...(w.reactors ?? [])]);
    for (const k of w.reactors ?? []) {
      if (reactorToWorkshop.has(k)) throw new ExitError(1, `reactor ${k} belongs to multiple workshops`);
      reactorToWorkshop.set(k, w.id);
    }
  }

  const recipes = new Map();
  for (const r of data.recipes ?? []) {
    if (recipes.has(r.id)) throw new ExitError(1, `duplicate recipe ${r.id}`);
    const versions = [...(r.versions ?? [])];
    for (let i = 1; i < versions.length; i++) {
      if (versions[i] <= versions[i - 1]) {
        throw new ExitError(EXIT.ROLLBACK, `recipe ${r.id} version rollback in recipes.json (${versions[i - 1]} -> ${versions[i]})`);
      }
    }
    recipes.set(r.id, {
      versions: new Set(versions),
      max: versions.length ? Math.max(...versions) : 0,
    });
  }

  const knownRef = (ref) => {
    const at = typeof ref === 'string' ? ref.lastIndexOf('@') : -1;
    if (at <= 0) return false;
    const rec = recipes.get(ref.slice(0, at));
    return !!rec && rec.versions.has(Number(ref.slice(at + 1)));
  };

  const forbidden = new Map();
  for (const pair of data.forbidden ?? []) {
    if (!Array.isArray(pair) || pair.length !== 2) {
      throw new ExitError(1, `forbidden entry must be [refA, refB], got ${JSON.stringify(pair)}`);
    }
    const [a, b] = pair;
    if (!knownRef(a) || !knownRef(b)) {
      throw new ExitError(1, `forbidden edge references unknown recipe version: ${a} -> ${b}`);
    }
    if (!forbidden.has(a)) forbidden.set(a, new Set());
    forbidden.get(a).add(b);
  }

  // Directed cycle detection in the forbidden table (a -> b means: feeding b
  // into a reactor that already contains a is forbidden).
  const color = new Map();
  const visit = (node, stack) => {
    color.set(node, 1);
    for (const next of forbidden.get(node) ?? []) {
      const c = color.get(next) ?? 0;
      if (c === 1) {
        throw new ExitError(EXIT.CYCLE, `forbidden table cycle: ${[...stack, node, next].join(' -> ')}`);
      }
      if (c === 0) visit(next, [...stack, node]);
    }
    color.set(node, 2);
  };
  for (const node of forbidden.keys()) {
    if (!color.has(node)) visit(node, []);
  }

  return { factory: data.factory, workshops, reactorToWorkshop, recipes, forbidden };
}

export function loadJsonl(path) {
  let text;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (err) {
    throw new ExitError(1, `cannot read ${path}: ${err.message}`);
  }
  const out = [];
  text.split('\n').forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      throw new ExitError(1, `${path}:${i + 1}: invalid JSON line`);
    }
    if (typeof obj.ts !== 'number') throw new ExitError(1, `${path}:${i + 1}: missing numeric ts`);
    out.push(obj);
  });
  return out;
}

export function mergeEvents(approvals, attempts) {
  const tagged = [
    ...approvals.map((e) => ({ e, src: 0 })),
    ...attempts.map((e) => ({ e, src: 1 })),
  ];
  tagged.sort((a, b) => a.e.ts - b.e.ts || a.src - b.src);
  return tagged.map((t) => t.e);
}
