import type { Row } from './conditions.js';

export const MASKED = null;

export interface AggregateSpec {
  op: 'count' | 'sum' | 'avg' | 'min' | 'max';
  field?: string;
  as: string;
}

export interface Query {
  where?: import('./conditions.js').Condition | undefined;
  select?: string[] | undefined;
  aggregates?: AggregateSpec[] | undefined;
}

export type ResultRow = { id: Row['id']; [key: string]: unknown };

export interface QueryResult {
  rows: ResultRow[];
  aggregates: Record<string, number | null>;
}
