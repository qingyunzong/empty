/**
 * A deliberately small, independent reference interpreter.
 *
 * It re-implements the same template semantics in the most direct way
 * possible (plain string concatenation, no provenance, no limits) so the
 * test-suite can cross-check that renderWithProvenance() produces exactly
 * the same text and that its provenance map faithfully reconstructs it.
 */

import { Node, parse } from './template.js';

type Ctx = Record<string, unknown>;

function resolve(path: string[], scopes: Ctx[], data: Ctx): unknown {
  const head = path[0]!;
  for (let i = scopes.length - 1; i >= 0; i--) {
    if (head in scopes[i]!) {
      return path.slice(1).reduce<unknown>(
        (v, k) => (v !== null && typeof v === 'object' ? (v as Ctx)[k] : undefined),
        scopes[i]![head],
      );
    }
  }
  return path.slice(1).reduce<unknown>(
    (v, k) => (v !== null && typeof v === 'object' ? (v as Ctx)[k] : undefined),
    data[head],
  );
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') throw new Error('reference: not renderable');
  return String(v);
}

function exec(nodes: Node[], source: string, scopes: Ctx[], data: Ctx): string {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
        out += source.slice(n.start, n.end);
        break;
      case 'var':
        out += str(resolve(n.path, scopes, data));
        break;
      case 'if': {
        let v = resolve(n.cond.path, scopes, data);
        if (Array.isArray(v)) v = v.length > 0;
        const take = n.cond.negate ? !v : !!v;
        out += exec(take ? n.thenBody : n.elseBody, source, scopes, data);
        break;
      }
      case 'for': {
        const list = resolve(n.listPath, scopes, data);
        if (list === null || list === undefined) break;
        if (!Array.isArray(list)) throw new Error('reference: not an array');
        for (const item of list) {
          out += exec(n.body, source, [...scopes, { [n.itemName]: item }], data);
        }
        break;
      }
    }
  }
  return out;
}

export function renderPlain(source: string, data: Ctx): string {
  return exec(parse(source), source, [], data);
}
