import { BoolExpr, evalBool, renderBool } from './expr';
import { Table } from './table';
import { TRUE, Value } from './values';

export type Plan =
  | { kind: 'scan'; table: Table }
  | { kind: 'filter'; pred: BoolExpr; child: Plan }
  | { kind: 'project'; cols: string[]; child: Plan }
  | { kind: 'innerJoin'; pred: BoolExpr; left: Plan; right: Plan }
  | { kind: 'leftJoin'; pred: BoolExpr; left: Plan; right: Plan };

export const scan = (table: Table): Plan => ({ kind: 'scan', table });
export const filter = (pred: BoolExpr, child: Plan): Plan => ({ kind: 'filter', pred, child });
export const project = (cols: string[], child: Plan): Plan => ({ kind: 'project', cols, child });
export const innerJoin = (pred: BoolExpr, left: Plan, right: Plan): Plan => ({ kind: 'innerJoin', pred, left, right });
export const leftJoin = (pred: BoolExpr, left: Plan, right: Plan): Plan => ({ kind: 'leftJoin', pred, left, right });

export function schemaOf(p: Plan): string[] {
  switch (p.kind) {
    case 'scan': return p.table.schema;
    case 'filter': return schemaOf(p.child);
    case 'project': return p.cols;
    case 'innerJoin':
    case 'leftJoin': return [...schemaOf(p.left), ...schemaOf(p.right)];
  }
}

function checkJoinSchemas(l: string[], r: string[]): void {
  const dup = l.filter((c) => r.includes(c));
  if (dup.length > 0) throw new Error(`join inputs share columns: ${dup.join(', ')}`);
}

/** 执行计划，返回行多重集（schema 为 schemaOf(p)）。 */
export function evalPlan(p: Plan): Value[][] {
  switch (p.kind) {
    case 'scan':
      return p.table.rows.map((r) => [...r]);
    case 'filter': {
      const schema = schemaOf(p.child);
      return evalPlan(p.child).filter((row) => evalBool(p.pred, row, schema) === TRUE);
    }
    case 'project': {
      const schema = schemaOf(p.child);
      const idx = p.cols.map((c) => {
        const i = schema.indexOf(c);
        if (i < 0) throw new Error(`project: unknown column ${c}`);
        return i;
      });
      return evalPlan(p.child).map((row) => idx.map((i) => row[i] ?? null));
    }
    case 'innerJoin': {
      const ls = schemaOf(p.left);
      const rs = schemaOf(p.right);
      checkJoinSchemas(ls, rs);
      const schema = [...ls, ...rs];
      const out: Value[][] = [];
      for (const l of evalPlan(p.left))
        for (const r of evalPlan(p.right)) {
          const row = [...l, ...r];
          if (evalBool(p.pred, row, schema) === TRUE) out.push(row);
        }
      return out;
    }
    case 'leftJoin': {
      const ls = schemaOf(p.left);
      const rs = schemaOf(p.right);
      checkJoinSchemas(ls, rs);
      const schema = [...ls, ...rs];
      const nulls: Value[] = rs.map(() => null);
      const out: Value[][] = [];
      for (const l of evalPlan(p.left)) {
        let matched = false;
        for (const r of evalPlan(p.right)) {
          const row = [...l, ...r];
          if (evalBool(p.pred, row, schema) === TRUE) {
            out.push(row);
            matched = true;
          }
        }
        if (!matched) out.push([...l, ...nulls]); // 未匹配左行补 NULL
      }
      return out;
    }
  }
}

export function renderPlan(p: Plan): string {
  switch (p.kind) {
    case 'scan': return `(scan ${p.table.name})`;
    case 'filter': return `(filter ${renderBool(p.pred)} ${renderPlan(p.child)})`;
    case 'project': return `(project [${p.cols.join(',')}] ${renderPlan(p.child)})`;
    case 'innerJoin': return `(inner-join ${renderBool(p.pred)} ${renderPlan(p.left)} ${renderPlan(p.right)})`;
    case 'leftJoin': return `(left-join ${renderBool(p.pred)} ${renderPlan(p.left)} ${renderPlan(p.right)})`;
  }
}
