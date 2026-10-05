/**
 * config-merge: layered configuration merging.
 *
 * Rules:
 *  - plain objects merge recursively, key by key;
 *  - arrays merge by a stable id key (default "id"): elements with the same
 *    id merge recursively, unmatched elements append in override order,
 *    base order is preserved;
 *  - explicit deletion via the DELETE symbol or a `{ $delete: true }` marker
 *    (array form: `{ id: "x", $delete: true }`). Deleting an item that does
 *    not exist in lower layers still keeps a tombstone in the merged node so
 *    it shadows any ancestor base the result is later merged onto;
 *  - if the value type changes between layers (object/array/scalar), the
 *    higher layer replaces the whole subtree.
 *
 * `mergeAll` also produces a provenance report: for every item in the final
 * config, which layer decided it and by which rule.
 */

export const DELETE: unique symbol = Symbol('config-merge.DELETE');
export const DELETE_KEY = '$delete';

const TOMBSTONE: unique symbol = Symbol('config-merge.tombstone');

interface TombstoneNode {
  readonly [TOMBSTONE]: true;
  readonly id?: string | number;
}

const makeTombstone = (id?: string | number): TombstoneNode =>
  id === undefined ? { [TOMBSTONE]: true } : { [TOMBSTONE]: true, id };

export const isTombstone = (v: unknown): v is TombstoneNode =>
  typeof v === 'object' && v !== null && (v as Record<PropertyKey, unknown>)[TOMBSTONE] === true;

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** True for the DELETE symbol or a `{ $delete: true }` marker object. */
export function isDeleteMarker(v: unknown): boolean {
  if (v === DELETE) return true;
  return isPlainObject(v) && v[DELETE_KEY] === true;
}

export type Seg = string | number | { id: string | number };

export type Rule =
  | 'add'          // item introduced by this layer
  | 'inherit'      // only lower layers define it (container with no direct event)
  | 'override'     // scalar replaces scalar
  | 'merge'        // object/array merged recursively
  | 'id-merge'     // array element merged by stable id
  | 'append'       // array element appended (no matching id)
  | 'type-replace' // type changed: whole subtree replaced
  | 'delete'       // explicit deletion of an existing item
  | 'tombstone';   // deletion of a non-existent item, tombstone kept

export interface ProvenanceEntry {
  segs: Seg[];
  path: string;
  source: number; // decisive layer index; -1 = multiple/none (containers)
  rule: Rule;
}

export interface MergeOptions {
  idKey?: string; // stable id key for array elements, default "id"
}

export interface MergeResult {
  value: unknown; // materialized config, tombstones stripped
  report: ProvenanceEntry[]; // per-item provenance, in document order
  tombstones: ProvenanceEntry[]; // deletions (kept internally to shadow ancestors)
}

interface State {
  prov: Map<string, ProvenanceEntry>;
  tombstones: ProvenanceEntry[];
}

interface Ctx {
  idKey: string;
  layer: number;
  state: State;
}

// ---------- paths ----------

export function formatPath(segs: Seg[]): string {
  let out = '';
  for (const s of segs) {
    if (typeof s === 'string') out += out ? `.${s}` : s;
    else if (typeof s === 'number') out += `[${s}]`;
    else out += `[id=${JSON.stringify(s.id)}]`;
  }
  return out || '(root)';
}

const keyOf = (segs: Seg[]): string => JSON.stringify(segs);

function segEq(a: Seg, b: Seg): boolean {
  if (typeof a === 'object' && typeof b === 'object') return a.id === b.id;
  return a === b;
}

function isPrefix(prefix: Seg[], segs: Seg[]): boolean {
  return prefix.length <= segs.length && prefix.every((s, i) => segEq(s, segs[i]));
}

// ---------- provenance helpers ----------

function setProv(ctx: Ctx, segs: Seg[], rule: Rule): void {
  ctx.state.prov.set(keyOf(segs), { segs, path: formatPath(segs), source: ctx.layer, rule });
}

function elementSeg(idKey: string, el: unknown, index: number): Seg {
  const id = idOf(idKey, el);
  return id !== undefined ? { id } : index;
}

function setProvDeep(ctx: Ctx, node: unknown, segs: Seg[], rule: Rule): void {
  if (isPlainObject(node) && !isDeleteMarker(node)) {
    setProv(ctx, segs, rule);
    const keys = Object.keys(node);
    if (keys.length === 0) setProv(ctx, segs, rule);
    else for (const k of keys) setProvDeep(ctx, node[k], [...segs, k], rule);
  } else if (Array.isArray(node)) {
    setProv(ctx, segs, rule);
    if (node.length === 0) setProv(ctx, segs, rule);
    else node.forEach((el, i) => setProvDeep(ctx, el, [...segs, elementSeg(ctx.idKey, el, i)], rule));
  } else {
    setProv(ctx, segs, rule);
  }
}

function removeProv(ctx: Ctx, segs: Seg[]): void {
  for (const [k, e] of ctx.state.prov) {
    if (isPrefix(segs, e.segs)) ctx.state.prov.delete(k);
  }
  ctx.state.tombstones = ctx.state.tombstones.filter((e) => !isPrefix(segs, e.segs));
}

// ---------- node utilities ----------

type Kind = 'object' | 'array' | 'value';

function kindOf(v: unknown): Kind {
  if (Array.isArray(v)) return 'array';
  if (isPlainObject(v)) return 'object';
  return 'value';
}

function idOf(idKey: string, el: unknown): string | number | undefined {
  if (!isPlainObject(el)) return undefined;
  const id = el[idKey];
  return typeof id === 'string' || typeof id === 'number' ? id : undefined;
}

function cloneNode<T>(v: T): T {
  if (Array.isArray(v)) return v.map(cloneNode) as T;
  if (isTombstone(v)) return v;
  if (isPlainObject(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) o[k] = cloneNode(v[k]);
    return o as T;
  }
  return v;
}

/** Deep-clone a merged node into plain data, stripping all tombstones. */
export function materialize(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((e) => !isTombstone(e)).map(materialize);
  if (isTombstone(v)) return undefined;
  if (isPlainObject(v)) {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      if (isTombstone(v[k])) continue;
      o[k] = materialize(v[k]);
    }
    return o;
  }
  return v;
}

// ---------- merge ----------

function mergeValue(base: unknown, over: unknown, segs: Seg[], ctx: Ctx): unknown {
  if (isDeleteMarker(over) || isTombstone(over)) {
    removeProv(ctx, segs);
    const existed = base !== undefined && !isTombstone(base);
    ctx.state.tombstones.push({
      segs,
      path: formatPath(segs),
      source: ctx.layer,
      rule: existed ? 'delete' : 'tombstone',
    });
    return makeTombstone();
  }
  if (over === undefined) return base;
  if (base === undefined || isTombstone(base)) {
    // new item, or re-definition after a delete
    setProvDeep(ctx, over, segs, 'add');
    return cloneNode(over);
  }
  const kb = kindOf(base);
  const ko = kindOf(over);
  if (kb !== ko) {
    removeProv(ctx, segs);
    setProvDeep(ctx, over, segs, 'type-replace');
    return cloneNode(over);
  }
  if (kb === 'object') return mergeObject(base as Record<string, unknown>, over as Record<string, unknown>, segs, ctx);
  if (kb === 'array') return mergeArray(base as unknown[], over as unknown[], segs, ctx);
  setProv(ctx, segs, 'override');
  return over;
}

function mergeObject(base: Record<string, unknown>, over: Record<string, unknown>, segs: Seg[], ctx: Ctx): Record<string, unknown> {
  setProv(ctx, segs, 'merge');
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = mergeValue(base[k], over[k], [...segs, k], ctx);
  }
  return out;
}

function mergeArray(base: unknown[], over: unknown[], segs: Seg[], ctx: Ctx): unknown[] {
  setProv(ctx, segs, 'merge');
  const out = base.slice();
  const posById = new Map<string | number, number>();
  out.forEach((el, i) => {
    const id = idOf(ctx.idKey, el);
    if (id !== undefined) posById.set(id, i);
  });
  for (const el of over) {
    if (isDeleteMarker(el) || isTombstone(el)) {
      const id = isTombstone(el) ? el.id : isPlainObject(el) ? el[ctx.idKey] : undefined;
      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new Error(`array delete marker at ${formatPath(segs)} requires a stable id ("${ctx.idKey}")`);
      }
      const elSegs: Seg[] = [...segs, { id }];
      removeProv(ctx, elSegs);
      const pos = posById.get(id);
      const existed = pos !== undefined && !isTombstone(out[pos]);
      ctx.state.tombstones.push({
        segs: elSegs,
        path: formatPath(elSegs),
        source: ctx.layer,
        rule: existed ? 'delete' : 'tombstone',
      });
      const tomb = makeTombstone(id);
      if (pos !== undefined) out[pos] = tomb;
      else {
        posById.set(id, out.length);
        out.push(tomb);
      }
      continue;
    }
    const id = idOf(ctx.idKey, el);
    if (id !== undefined && posById.has(id)) {
      const pos = posById.get(id)!;
      const elSegs: Seg[] = [...segs, { id }];
      if (isTombstone(out[pos])) {
        // re-add after delete
        setProvDeep(ctx, el, elSegs, 'add');
        out[pos] = cloneNode(el);
      } else {
        out[pos] = mergeValue(out[pos], el, elSegs, ctx);
        setProv(ctx, elSegs, 'id-merge');
      }
    } else {
      const elSegs: Seg[] = [...segs, id !== undefined ? { id } : out.length];
      setProvDeep(ctx, el, elSegs, 'append');
      if (id !== undefined) posById.set(id, out.length);
      out.push(cloneNode(el));
    }
  }
  return out;
}

function buildReport(value: unknown, prov: Map<string, ProvenanceEntry>, idKey: string): ProvenanceEntry[] {
  const out: ProvenanceEntry[] = [];
  const walk = (node: unknown, segs: Seg[]): void => {
    const e = prov.get(keyOf(segs));
    if (isPlainObject(node)) {
      out.push(e ?? { segs, path: formatPath(segs), source: -1, rule: 'merge' });
      for (const k of Object.keys(node)) walk(node[k], [...segs, k]);
    } else if (Array.isArray(node)) {
      out.push(e ?? { segs, path: formatPath(segs), source: -1, rule: 'merge' });
      node.forEach((el, i) => walk(el, [...segs, elementSeg(idKey, el, i)]));
    } else {
      out.push(e ?? { segs, path: formatPath(segs), source: -1, rule: 'inherit' });
    }
  };
  walk(value, []);
  return out;
}

/**
 * Merge `over` onto `base`, returning the internal merged node.
 * The result may contain tombstones; use `materialize` to strip them.
 * Input nodes are never mutated.
 */
export function mergeNodes(base: unknown, over: unknown, opts: MergeOptions = {}): unknown {
  const state: State = { prov: new Map(), tombstones: [] };
  const ctx: Ctx = { idKey: opts.idKey ?? 'id', layer: 1, state };
  return mergeValue(base, over, [], ctx);
}

/**
 * Merge layers from lowest to highest priority.
 * Returns the materialized config plus a per-item provenance report.
 */
export function mergeAll(layers: unknown[], opts: MergeOptions = {}): MergeResult {
  const idKey = opts.idKey ?? 'id';
  const state: State = { prov: new Map(), tombstones: [] };
  let acc: unknown = undefined;
  layers.forEach((layer, i) => {
    const ctx: Ctx = { idKey, layer: i, state };
    acc = mergeValue(acc, layer, [], ctx);
  });
  const value = materialize(acc);
  return { value, report: buildReport(value, state.prov, idKey), tombstones: state.tombstones };
}

/** Convenience two-layer merge. */
export function merge(base: unknown, override: unknown, opts: MergeOptions = {}): MergeResult {
  return mergeAll([base, override], opts);
}
