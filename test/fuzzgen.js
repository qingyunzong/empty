// Seeded random ruleset/event generator. Produces DSL source text that always
// passes static checks: inner-level thresholds either tighten the outer bound
// or carry an explicit `override`.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHANNELS = ['payx', 'web', 'app'];
const MERCHANTS = ['M1001', 'M2002', 'M3003', 'M4004'];
const CIDRS = ['10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12'];
const REGEXES = ['M10\\d+', 'M\\d{4}', 'vip|promo', '[a-z]+'];
const LEVEL_RANK = { global: 0, channel: 1, merchant: 2 };

export function genRulesetSource(rand) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const facts = []; // {level, decision, field, dir, value}

  function thresholdStmt(level) {
    const decision = pick(['deny', 'deny', 'review', 'allow']);
    const useMoney = rand() < 0.7;
    const field = useMoney ? 'amount' : 'count';
    const dir = pick(['low', 'high']);
    const op = dir === 'low' ? '>' : '<';
    const maxV = useMoney ? 20000 : 50;
    const outers = facts.filter((f) =>
      f.decision === decision && f.field === field && f.dir === dir
      && LEVEL_RANK[f.level] < LEVEL_RANK[level]);
    let value;
    let override = false;
    if (outers.length === 0) {
      value = int(0, maxV);
    } else {
      // Polarity: deny/review tighten when their trigger set grows, allow
      // tightens when it shrinks. dir 'low' => trigger is (v, inf), so a
      // smaller v means a bigger trigger.
      const restrictive = decision !== 'allow';
      const tightenIncreases = restrictive === (dir === 'high');
      const loosen = rand() < 0.25;
      const increases = loosen ? !tightenIncreases : tightenIncreases;
      const delta = loosen ? int(1, 3000) : int(0, 3000);
      value = increases
        ? Math.min(maxV, Math.max(...outers.map((f) => f.value)) + delta)
        : Math.max(0, Math.min(...outers.map((f) => f.value)) - delta);
      override = loosen;
    }
    facts.push({ level, decision, field, dir, value });
    const lit = useMoney ? `${value}CNY` : `${value}`;
    return `${override ? 'override ' : ''}${decision} when ${field} ${op} ${lit}`;
  }

  function leaf() {
    switch (int(0, 6)) {
      case 0: return `amount ${pick(['>', '>=', '<', '<='])} ${int(0, 20000)}CNY`;
      case 1: return `count ${pick(['>', '>=', '<', '<='])} ${int(0, 50)}`;
      case 2: return `ip in ${pick(CIDRS)}`;
      case 3: {
        const n = int(1, 3);
        const pool = [...MERCHANTS];
        const items = [];
        for (let k = 0; k < n; k++) items.push(pool.splice(int(0, pool.length - 1), 1)[0]);
        return `merchant in [${items.join(', ')}]`;
      }
      case 4: return `${pick(['merchant', 'tag'])} in /${pick(REGEXES)}/`;
      case 5: return `channel == ${pick(CHANNELS)}`;
      default: {
        const a = int(0, 10000);
        return `amount in ${a}CNY..${a + int(0, 10000)}CNY`;
      }
    }
  }

  function expr(depth) {
    if (depth <= 0) return leaf();
    const r = rand();
    if (r < 0.4) return leaf();
    if (r < 0.55) return `not (${expr(depth - 1)})`;
    return `(${expr(depth - 1)}) ${r < 0.8 ? 'and' : 'or'} (${expr(depth - 1)})`;
  }

  const rules = [];
  const counters = { global: 0, channel: 0, merchant: 0 };
  const layout = [['global', int(1, 2)], ['channel', int(0, 2)], ['merchant', int(0, 2)]];
  for (const [level, n] of layout) {
    for (let i = 0; i < n; i++) {
      const name = `${level[0]}${counters[level]++}`;
      let header = `rule ${name} level ${level}`;
      if (level === 'channel') header += ` match channel ${pick(CHANNELS)}`;
      if (level === 'merchant') header += ` match merchant ${pick(MERCHANTS)}`;
      const stmts = [];
      const ns = int(1, 3);
      for (let s = 0; s < ns; s++) {
        if (rand() < 0.5) {
          stmts.push(thresholdStmt(level));
        } else {
          // Compound top level so the override checker (simple thresholds only)
          // is not triggered by untracked nested comparisons.
          const decision = pick(['deny', 'review', 'allow']);
          stmts.push(`${decision} when (${leaf()}) ${pick(['and', 'or'])} (${expr(2)})`);
        }
      }
      rules.push(`${header} {\n  ${stmts.join('\n  ')}\n}`);
    }
  }
  return `version 1\nvalid_from 2026-01-01T00:00:00Z\n\n${rules.join('\n\n')}\n`;
}

export function genEvent(rand, i) {
  const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const event = {
    id: `f${i}`,
    ts: '2026-03-15T12:00:00Z',
    merchant: pick([...MERCHANTS, 'M9999']),
    channel: pick([...CHANNELS, 'other']),
    ip: pick(['10.1.2.3', '10.255.0.1', '192.168.1.1', '8.8.8.8', '172.16.5.5', 'bad-ip']),
    amount: int(0, 25000),
    currency: pick(['CNY', 'CNY', 'CNY', 'USD']),
    count: int(0, 60),
    tag: pick(['new', 'vip', 'risky', 'promo', 'x9']),
  };
  const rv = rand();
  if (rv < 0.25) event.review = 'pending';
  else if (rv < 0.35) event.review = 'approved';
  else if (rv < 0.45) event.review = 'rejected';
  return event;
}
