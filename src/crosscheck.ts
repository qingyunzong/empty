import { deepStrictEqual } from 'node:assert';
import type { Row } from './conditions.js';
import type { Policy } from './policy.js';
import type { Query, QueryResult } from './query.js';
import { runAuthorizeFirst } from './engineAuthorizeFirst.js';
import { runInline } from './engineInline.js';

export interface CrossCheckResult {
  ok: boolean;
  authorizeFirst: QueryResult;
  inline: QueryResult;
}

export function crossCheck(table: Row[], policy: Policy, query: Query = {}): CrossCheckResult {
  const authorizeFirst = runAuthorizeFirst(table, policy, query);
  const inline = runInline(table, policy, query);
  try {
    deepStrictEqual(authorizeFirst, inline);
    return { ok: true, authorizeFirst, inline };
  } catch {
    return { ok: false, authorizeFirst, inline };
  }
}
