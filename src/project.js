import { step } from './machine.js';

// a 是否因果不早于 b（a happens-after-or-equal b）
export function dominates(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) if ((a?.[k] ?? 0) < (b?.[k] ?? 0)) return false;
  return true;
}

export function concurrent(a, b) {
  return !dominates(a, b) && !dominates(b, a);
}

export function compareEvents(a, b) {
  if (a.site !== b.site) return a.site < b.site ? -1 : 1;
  return a.seq - b.seq;
}

function causallyReady(ev, clock) {
  if ((clock[ev.site] ?? 0) !== ev.seq - 1) return false;
  for (const [site, count] of Object.entries(ev.vclock)) {
    if (site === ev.site) continue;
    if ((clock[site] ?? 0) < count) return false;
  }
  return true;
}

function defer(ctx, ev, reason) {
  ctx.deferred.set(ev.id, reason);
  return 'defer';
}

function hasActiveAlarm(order) {
  return Object.values(order.alarms).some((a) => a.raised);
}

function compareTeamId(a, b) {
  const ta = a.data?.team ?? '';
  const tb = b.data?.team ?? '';
  if (ta !== tb) return ta < tb ? -1 : 1;
  return compareEvents(a, b);
}

function applyEvent(ev, ctx) {
  const { orders, decisions, conflicts, held, heldEvents, byId } = ctx;
  for (const h of heldEvents) {
    if (ev.id !== h.id && dominates(ev.vclock, h.vclock)) {
      decisions.set(ev.id, { status: 'held', reason: 'blocked-by-safety-conflict', blocker: h.id });
      return 'done';
    }
  }
  if (held.has(ev.id)) {
    decisions.set(ev.id, { status: 'held', reason: 'safety-conflict' });
    return 'done';
  }
  const o = orders[ev.order];
  switch (ev.type) {
    case 'create': {
      if (o) {
        decisions.set(ev.id, { status: 'rejected', reason: 'duplicate-create' });
        return 'done';
      }
      orders[ev.order] = {
        status: 'created', team: null, assignee: null,
        safety: !!ev.data?.safety, alarms: {}, assignEvent: null, history: [ev.id],
      };
      decisions.set(ev.id, { status: 'applied' });
      return 'done';
    }
    case 'assign': {
      if (!o) return defer(ctx, ev, 'unknown-order');
      if (o.status === 'assigned' && o.assignEvent) {
        const prev = o.assignEvent;
        const samePerson = (prev.actor ?? null) === (ev.actor ?? null);
        const diffTeam = (prev.data?.team ?? null) !== (ev.data?.team ?? null);
        if (concurrent(prev.vclock, ev.vclock) && samePerson && diffTeam) {
          if (o.safety) {
            // 安全联锁冲突：双方挂起，整个投影重算
            held.add(prev.id);
            held.add(ev.id);
            conflicts.push({ kind: 'safety-interlock', order: ev.order, events: [prev.id, ev.id], status: 'pending' });
            return 'restart';
          }
          // 确定性规则：(team, site, seq) 字典序小者胜
          const winner = compareTeamId(ev, prev) < 0 ? ev : prev;
          const loser = winner === ev ? prev : ev;
          o.team = winner.data?.team ?? null;
          o.assignee = winner.actor ?? winner.data?.assignee ?? null;
          o.assignEvent = winner;
          o.history.push(ev.id);
          decisions.set(winner.id, { status: 'applied' });
          decisions.set(loser.id, { status: 'superseded', by: winner.id });
          conflicts.push({ kind: 'assign-team', order: ev.order, winner: winner.id, loser: loser.id, rule: 'team-lexicographic' });
          return 'done';
        }
      }
      const r = step(o.status, 'assign');
      if (!r.ok) {
        decisions.set(ev.id, { status: 'rejected', reason: r.reason });
        return 'done';
      }
      o.status = r.status;
      o.team = ev.data?.team ?? null;
      o.assignee = ev.actor ?? ev.data?.assignee ?? null;
      o.assignEvent = ev;
      o.history.push(ev.id);
      decisions.set(ev.id, { status: 'applied' });
      return 'done';
    }
    case 'start':
    case 'complete':
    case 'cancel': {
      if (!o) return defer(ctx, ev, 'unknown-order');
      const r = step(o.status, ev.type);
      if (!r.ok) {
        decisions.set(ev.id, { status: 'rejected', reason: r.reason });
        return 'done';
      }
      if (ev.type === 'complete' && hasActiveAlarm(o)) {
        decisions.set(ev.id, { status: 'rejected', reason: 'alarm-active' });
        return 'done';
      }
      o.status = r.status;
      o.history.push(ev.id);
      decisions.set(ev.id, { status: 'applied' });
      return 'done';
    }
    case 'raise': {
      if (!o) return defer(ctx, ev, 'unknown-order');
      const alarmId = String(ev.data?.alarm);
      const existing = o.alarms[alarmId];
      if (existing && existing.raised) {
        const prevRaise = byId.get(existing.raiseEvent);
        if (prevRaise && compareEvents(prevRaise, ev) <= 0) {
          decisions.set(ev.id, { status: 'superseded', by: existing.raiseEvent });
          return 'done';
        }
        decisions.set(existing.raiseEvent, { status: 'superseded', by: ev.id });
      }
      o.alarms[alarmId] = { raised: true, raiseEvent: ev.id, raiseVclock: ev.vclock };
      o.history.push(ev.id);
      decisions.set(ev.id, { status: 'applied' });
      return 'done';
    }
    case 'clear': {
      if (!o) return defer(ctx, ev, 'unknown-order');
      const alarmId = String(ev.data?.alarm);
      const alarm = o.alarms[alarmId];
      if (!alarm || !alarm.raised) {
        const raiseKnown = [...byId.values()].some(
          (e) => e.type === 'raise' && e.order === ev.order && String(e.data?.alarm) === alarmId,
        );
        if (!raiseKnown) return defer(ctx, ev, 'raise-unknown');
        decisions.set(ev.id, { status: 'rejected', reason: 'clear-before-raise' });
        return 'done';
      }
      // clear 必须因果晚于 raise 才有效
      if (!dominates(ev.vclock, alarm.raiseVclock)) {
        decisions.set(ev.id, { status: 'rejected', reason: 'clear-before-raise' });
        return 'done';
      }
      alarm.raised = false;
      alarm.clearedBy = ev.id;
      o.history.push(ev.id);
      decisions.set(ev.id, { status: 'applied' });
      return 'done';
    }
    default:
      decisions.set(ev.id, { status: 'rejected', reason: 'unknown-type' });
      return 'done';
  }
}

function runProjection(events, byId, held, conflicts) {
  const sorted = [...events].sort(compareEvents);
  const clock = {};
  const orders = {};
  const decisions = new Map();
  const remaining = new Map(sorted.map((e) => [e.id, e]));
  const deferred = new Map();
  const heldEvents = [...held].map((id) => byId.get(id)).filter(Boolean);
  const ctx = { orders, decisions, conflicts, held, heldEvents, byId, deferred };

  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, ev] of remaining) {
      if (!causallyReady(ev, clock)) continue;
      const outcome = applyEvent(ev, ctx);
      if (outcome === 'restart') return { restart: true };
      if (outcome === 'defer') continue;
      clock[ev.site] = ev.seq;
      remaining.delete(id);
      progressed = true;
    }
  }
  const pending = [];
  for (const [id, ev] of remaining) {
    const reason = deferred.get(id) ?? (causallyReady(ev, clock) ? 'unresolved' : 'causal-gap');
    decisions.set(id, { status: 'pending', reason });
    pending.push({ id, reason });
  }
  return { restart: false, orders, clock, decisions, pending, conflicts };
}

// 投影是事件集合的纯函数：确定性拓扑序（因果优先，(site,seq) 决胜），
// 重复回放不会产生重复效果，满足恰好一次。
export function project(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const held = new Set();
  const conflicts = [];
  for (;;) {
    const result = runProjection(events, byId, held, conflicts);
    if (!result.restart) return result;
  }
}
