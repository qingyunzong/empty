import { QuotaError } from './errors.js';
import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { check } from './check.js';
import { compile } from './compiler.js';
import { buildPolicy, evalExpr } from './vm.js';

export function compileScript(source) {
  const ast = parse(tokenize(source));
  check(ast);
  return compile(ast);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function eventDay(ev) {
  if (ev && ev.type === 'tick') return typeof ev.date === 'string' ? ev.date : null;
  return ev && typeof ev.ts === 'string' ? ev.ts.slice(0, 10) : null;
}

function eventTs(ev) {
  if (ev && ev.type === 'tick') {
    const ms = Date.parse(`${ev.date}T00:00:00Z`);
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  }
  const ms = Date.parse(ev && ev.ts);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

// 同一桶并发冻结按时间戳全序: (ts, id, 原始行号) — 确定性 tie-break
export function sortEvents(events) {
  return events
    .map((ev, seq) => ({ ev, seq }))
    .sort((a, b) => {
      const ta = eventTs(a.ev);
      const tb = eventTs(b.ev);
      if (ta !== tb) return ta < tb ? -1 : 1;
      const ai = String((a.ev && a.ev.id) ?? '');
      const bi = String((b.ev && b.ev.id) ?? '');
      if (ai !== bi) return ai < bi ? -1 : 1;
      return a.seq - b.seq;
    });
}

function resolveScope(policy, path) {
  if (path === undefined || path === null || path === '') return policy.root;
  if (typeof path !== 'string') return null;
  return policy.scopesByPath.get(path) ?? null;
}

function addConsumed(scopeNode, bucket, delta) {
  for (let n = scopeNode; n; n = n.parent) {
    n.consumed.set(bucket, (n.consumed.get(bucket) ?? 0) + delta);
  }
}

function checkCaps(scopeNode, bucket, amount) {
  for (let n = scopeNode; n; n = n.parent) {
    const cap = n.caps.get(bucket);
    if (cap === undefined) continue;
    const used = n.consumed.get(bucket) ?? 0;
    if (used + amount > cap) {
      return `scope '${n.path || '<root>'}' cap exceeded for '${bucket}': ${used} + ${amount} > ${cap}`;
    }
  }
  return null;
}

function checkGuards(policy, scopeNode, target, ev) {
  const chain = [];
  for (let n = scopeNode; n; n = n.parent) chain.unshift(n);
  for (const node of chain) {
    for (const g of node.guards) {
      if (g.target !== target) continue;
      for (const clause of g.clauses) {
        const val = evalExpr(clause.expr, {
          node,
          buckets: policy.buckets,
          amount: ev.amount ?? 0,
          note: ev.note ?? ev.ref ?? '',
        });
        if (clause.mode === 'when' && !val) {
          return `guard rejected ${target} in scope '${node.path || '<root>'}' (when-clause is false)`;
        }
        if (clause.mode === 'unless' && val) {
          return `guard rejected ${target} in scope '${node.path || '<root>'}' (unless-clause is true)`;
        }
      }
    }
  }
  return null;
}

const validAmount = (v) => Number.isSafeInteger(v) && v > 0;

export function applyEvents(policy, events) {
  const state = {
    currentDay: null,
    buckets: policy.buckets,
    freezes: [],
    log: [],
  };

  const failLog = (ev, seq, day, code, message) => {
    state.log.push({
      seq,
      id: (ev && ev.id) ?? null,
      type: (ev && ev.type) ?? 'invalid',
      bucket: (ev && ev.bucket) ?? null,
      day,
      status: 'error',
      code,
      message,
    });
  };
  const okLog = (ev, seq, day, extra = {}) => {
    state.log.push({
      seq,
      id: (ev && ev.id) ?? null,
      type: ev.type,
      bucket: ev.bucket ?? null,
      day,
      status: 'ok',
      ...extra,
    });
  };

  // 到期事件按业务日批量生效: 进入新业务日时, 一次性结算所有 until <= 当日的冻结
  function settleDay(newDay) {
    for (const f of state.freezes) {
      if (f.status !== 'active' || f.until > newDay) continue;
      const released = f.amount - f.used - f.released;
      const b = state.buckets.get(f.bucket);
      b.frozen -= released;
      b.available += released;
      addConsumed(policy.scopesByPath.get(f.scope) ?? policy.root, f.bucket, -released);
      f.status = 'expired';
      state.log.push({
        seq: null,
        id: null,
        type: 'expire',
        bucket: f.bucket,
        day: newDay,
        status: 'ok',
        note: f.note,
        released,
      });
    }
  }

  function findActiveFreeze(state, bucket, ref) {
    const active = state.freezes.find(
      (x) => x.bucket === bucket && x.note === ref && x.status === 'active',
    );
    if (active) return { f: active };
    const any = state.freezes.find((x) => x.bucket === bucket && x.note === ref);
    if (any && any.status === 'expired') return { expired: true };
    return {};
  }

  function applyOne(ev, seq, day) {
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') {
      return failLog(ev, seq, day, 'E_VALID', 'event must be an object with a type');
    }
    if (ev.type === 'tick') return okLog(ev, seq, day);

    const b = policy.buckets.get(ev.bucket);
    if (!b) return failLog(ev, seq, day, 'E_VALID', `unknown bucket '${ev.bucket}'`);
    if (policy.validity && (day < policy.validity.from || day > policy.validity.to)) {
      return failLog(ev, seq, day, 'E_EXPIRED',
        `event day ${day} outside policy validity ${policy.validity.from}..${policy.validity.to}`);
    }

    switch (ev.type) {
      case 'freeze': {
        if (!validAmount(ev.amount)) {
          return failLog(ev, seq, day, 'E_CAP', `freeze amount must be a positive integer, got ${ev.amount}`);
        }
        if (typeof ev.note !== 'string' ||
            (policy.noteWhitelist && !policy.noteWhitelist.test(ev.note))) {
          return failLog(ev, seq, day, 'E_NOTE', `note '${ev.note}' rejected by note whitelist`);
        }
        if (typeof ev.until !== 'string' || !DATE_RE.test(ev.until)) {
          return failLog(ev, seq, day, 'E_VALID', `freeze needs an until date (YYYY-MM-DD)`);
        }
        if (ev.until <= day) {
          return failLog(ev, seq, day, 'E_EXPIRED', `freeze until ${ev.until} is already expired on ${day}`);
        }
        const scope = resolveScope(policy, ev.scope);
        if (!scope) return failLog(ev, seq, day, 'E_SCOPE', `unknown approval scope '${ev.scope}'`);
        if (state.freezes.some((f) => f.bucket === ev.bucket && f.note === ev.note && f.status === 'active')) {
          return failLog(ev, seq, day, 'E_NOTE', `duplicate active freeze note '${ev.note}'`);
        }
        const gErr = checkGuards(policy, scope, 'freeze', ev);
        if (gErr) return failLog(ev, seq, day, 'E_GUARD', gErr);
        const cErr = checkCaps(scope, ev.bucket, ev.amount);
        if (cErr) return failLog(ev, seq, day, 'E_CAP', cErr);
        if (b.available < ev.amount) {
          // 超可用: 整体拒绝, 不得部分扣减
          return failLog(ev, seq, day, 'E_CAP',
            `insufficient available in '${ev.bucket}': need ${ev.amount}, have ${b.available}`);
        }
        b.available -= ev.amount;
        b.frozen += ev.amount;
        addConsumed(scope, ev.bucket, ev.amount);
        state.freezes.push({
          bucket: ev.bucket,
          note: ev.note,
          amount: ev.amount,
          used: 0,
          released: 0,
          until: ev.until,
          scope: scope.path,
          status: 'active',
          day,
        });
        return okLog(ev, seq, day);
      }
      case 'unfreeze': {
        if (!Number.isSafeInteger(ev.amount)) {
          return failLog(ev, seq, day, 'E_VALID', `unfreeze amount must be an integer, got ${ev.amount}`);
        }
        if (ev.amount <= 0) {
          return failLog(ev, seq, day, 'E_CAP', `unfreeze amount must be positive, got ${ev.amount}`);
        }
        const found = findActiveFreeze(state, ev.bucket, ev.ref);
        if (found.expired) {
          return failLog(ev, seq, day, 'E_EXPIRED', `freeze '${ev.ref}' already expired`);
        }
        if (!found.f) return failLog(ev, seq, day, 'E_VALID', `no active freeze '${ev.ref}' on bucket '${ev.bucket}'`);
        const f = found.f;
        const scope = resolveScope(policy, ev.scope ?? f.scope);
        if (!scope) return failLog(ev, seq, day, 'E_SCOPE', `unknown approval scope '${ev.scope}'`);
        const gErr = checkGuards(policy, scope, 'unfreeze', ev);
        if (gErr) return failLog(ev, seq, day, 'E_GUARD', gErr);
        // 解冻只能释放未使用冻结
        const releasable = f.amount - f.used - f.released;
        const released = Math.min(ev.amount, releasable);
        if (released <= 0) {
          return failLog(ev, seq, day, 'E_CAP', `freeze '${ev.ref}' is fully used, nothing to release`);
        }
        b.frozen -= released;
        b.available += released;
        addConsumed(policy.scopesByPath.get(f.scope) ?? policy.root, ev.bucket, -released);
        f.released += released;
        if (f.amount - f.used - f.released === 0) f.status = 'released';
        return okLog(ev, seq, day, { released });
      }
      case 'draw': {
        if (!validAmount(ev.amount)) {
          return failLog(ev, seq, day, 'E_CAP', `draw amount must be a positive integer, got ${ev.amount}`);
        }
        const found = findActiveFreeze(state, ev.bucket, ev.ref);
        if (found.expired) {
          return failLog(ev, seq, day, 'E_EXPIRED', `freeze '${ev.ref}' already expired`);
        }
        if (!found.f) return failLog(ev, seq, day, 'E_VALID', `no active freeze '${ev.ref}' on bucket '${ev.bucket}'`);
        const f = found.f;
        const scope = resolveScope(policy, ev.scope ?? f.scope);
        if (!scope) return failLog(ev, seq, day, 'E_SCOPE', `unknown approval scope '${ev.scope}'`);
        const gErr = checkGuards(policy, scope, 'draw', ev);
        if (gErr) return failLog(ev, seq, day, 'E_GUARD', gErr);
        const remaining = f.amount - f.used - f.released;
        if (ev.amount > remaining) {
          return failLog(ev, seq, day, 'E_CAP',
            `draw ${ev.amount} exceeds unused frozen ${remaining} on '${ev.ref}'`);
        }
        f.used += ev.amount;
        b.frozen -= ev.amount;
        b.used += ev.amount;
        return okLog(ev, seq, day);
      }
      case 'debit': {
        if (!validAmount(ev.amount)) {
          return failLog(ev, seq, day, 'E_CAP', `debit amount must be a positive integer, got ${ev.amount}`);
        }
        const scope = resolveScope(policy, ev.scope);
        if (!scope) return failLog(ev, seq, day, 'E_SCOPE', `unknown approval scope '${ev.scope}'`);
        const gErr = checkGuards(policy, scope, 'debit', ev);
        if (gErr) return failLog(ev, seq, day, 'E_GUARD', gErr);
        const cErr = checkCaps(scope, ev.bucket, ev.amount);
        if (cErr) return failLog(ev, seq, day, 'E_CAP', cErr);
        if (b.available < ev.amount) {
          return failLog(ev, seq, day, 'E_CAP',
            `insufficient available in '${ev.bucket}': need ${ev.amount}, have ${b.available}`);
        }
        b.available -= ev.amount;
        b.used += ev.amount;
        addConsumed(scope, ev.bucket, ev.amount);
        return okLog(ev, seq, day);
      }
      default:
        return failLog(ev, seq, day, 'E_VALID', `unknown event type '${ev.type}'`);
    }
  }

  for (const { ev, seq } of sortEvents(events)) {
    const day = eventDay(ev);
    if (!day || !DATE_RE.test(day)) {
      failLog(ev, seq, day, 'E_VALID', 'missing or invalid event timestamp/date');
      continue;
    }
    if (state.currentDay === null) {
      state.currentDay = day;
    } else if (day > state.currentDay) {
      settleDay(day);
      state.currentDay = day;
    }
    applyOne(ev, seq, day);
  }
  return state;
}

function serializeScopes(policy) {
  const out = {};
  for (const [path, node] of policy.scopesByPath) {
    out[path || '<root>'] = {
      caps: Object.fromEntries(node.caps),
      consumed: Object.fromEntries(node.consumed),
    };
  }
  return out;
}

export function serializeState(policy, state, script, events) {
  const applied = state.log.filter((l) => l.seq !== null && l.status === 'ok').length;
  const failed = state.log.filter((l) => l.seq !== null && l.status === 'error').length;
  return {
    version: 1,
    script,
    events,
    currentDay: state.currentDay,
    buckets: Object.fromEntries(
      [...state.buckets.entries()].map(([k, v]) => [k, { ...v }]),
    ),
    freezes: state.freezes.map((f) => ({ ...f })),
    scopes: serializeScopes(policy),
    log: state.log.map((l) => ({ ...l })),
    summary: { total: events.length, applied, failed },
  };
}

export function runAll(scriptSource, events) {
  const program = compileScript(scriptSource);
  const policy = buildPolicy(program);
  const state = applyEvents(policy, events);
  return { program, policy, state };
}

// 事件溯源回放: 从脚本 + 事件日志重建, 校验最终三额与日志一致
export function replay(saved) {
  const { policy, state } = runAll(saved.script, saved.events);
  const fresh = serializeState(policy, state, saved.script, saved.events);
  const mismatches = [];
  const cmp = (label, a, b) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push(label);
  };
  cmp('currentDay', fresh.currentDay, saved.currentDay);
  cmp('buckets', fresh.buckets, saved.buckets);
  cmp('freezes', fresh.freezes, saved.freezes);
  cmp('scopes', fresh.scopes, saved.scopes);
  const logSig = (log) => log.map((l) => [l.seq, l.type, l.status, l.code ?? null]);
  cmp('log', logSig(fresh.log), logSig(saved.log));
  return { ok: mismatches.length === 0, mismatches, state: fresh };
}
