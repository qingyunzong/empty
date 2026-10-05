'use strict';

// 差分测试：用完全独立的枚举参考实现核对 SessionStore。
// 参考实现自行维护有效点集合，最终化时排序有效点、枚举所有间隔分组并求均值，
// 不引用 src/ 下的任何代码。

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionStore } = require('../src/index');

const GAP = 10 * 60 * 1000;

function referenceRun(records) {
  const live = new Map();  // id -> {station, t, temp, version}
  const seen = new Map();  // id -> 已见最大版本（含已撤回/已最终化）
  const eventOf = new Map(); // id -> 事件时间（含已撤回/已最终化）
  let wm = -Infinity;
  const sessions = [];
  const errors = [];

  for (const rec of records) {
    if (rec.op === 'WATERMARK') {
      const w = Date.parse(rec.ts);
      if (w > wm) wm = w;
      const byStation = new Map();
      for (const [id, o] of live) {
        if (!byStation.has(o.station)) byStation.set(o.station, []);
        byStation.get(o.station).push({ id, ...o });
      }
      const finals = [];
      for (const [station, pts] of byStation) {
        pts.sort((p, q) => p.t - q.t || (p.id < q.id ? -1 : 1));
        // 枚举所有间隔分组：相邻间隔 > GAP 处断开
        let group = [];
        const groups = [];
        for (const p of pts) {
          if (group.length && p.t - group[group.length - 1].t > GAP) {
            groups.push(group);
            group = [];
          }
          group.push(p);
        }
        if (group.length) groups.push(group);
        for (const g of groups) {
          const maxT = g[g.length - 1].t;
          if (wm > maxT + GAP) {
            let sum = 0;
            let ver = -Infinity;
            for (const p of g) {
              sum += p.temp;
              if (p.version > ver) ver = p.version;
            }
            finals.push({
              station,
              start: new Date(g[0].t).toISOString(),
              end: new Date(maxT).toISOString(),
              count: g.length,
              avgTemp: sum / g.length,
              ids: g.map((p) => p.id),
              version: ver,
            });
            for (const p of g) live.delete(p.id);
          }
        }
      }
      finals.sort((a, b) =>
        a.station < b.station ? -1
          : a.station > b.station ? 1
            : a.start < b.start ? -1
              : a.start > b.start ? 1 : 0);
      sessions.push(...finals);
    } else if (rec.op === 'UPSERT') {
      const t = Date.parse(rec.eventTime);
      if (wm > t + GAP) { errors.push('LATE'); continue; }
      const sv = seen.get(rec.id);
      if (sv !== undefined) {
        if (rec.version < sv) { errors.push('STALE_VERSION'); continue; }
        if (rec.version === sv) continue;
        live.delete(rec.id);
      }
      live.set(rec.id, { station: rec.station, t, temp: rec.temp, version: rec.version });
      seen.set(rec.id, rec.version);
      eventOf.set(rec.id, t);
    } else if (rec.op === 'RETRACT') {
      const sv = seen.get(rec.id);
      if (sv === undefined) { errors.push('UNKNOWN_RETRACT'); continue; }
      const t = eventOf.get(rec.id);
      if (wm > t + GAP) { errors.push('LATE'); continue; }
      if (rec.version !== undefined && rec.version < sv) { errors.push('STALE_VERSION'); continue; }
      live.delete(rec.id);
      if (rec.version !== undefined && rec.version > sv) seen.set(rec.id, rec.version);
    }
  }
  return { sessions, errors };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateRecords(seed, count) {
  const rnd = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const stations = ['s1', 's2'];
  const base = Date.UTC(2026, 0, 1);
  const records = [];
  const versions = new Map(); // id -> 当前版本
  const liveIds = [];
  let wmMin = 0;

  for (let i = 0; i < count; i++) {
    const roll = rnd();
    if (roll < 0.6 || liveIds.length === 0) {
      // UPSERT：偶发版本回退
      const id = rnd() < 0.3 && liveIds.length ? pick(liveIds) : `id${Math.floor(rnd() * 12)}`;
      const cur = versions.get(id) || 0;
      const version = rnd() < 0.15 && cur > 0 ? cur - 1 : (versions.has(id) ? cur + (rnd() < 0.5 ? 0 : 1) : 1);
      versions.set(id, Math.max(versions.get(id) || 0, version));
      if (!liveIds.includes(id)) liveIds.push(id);
      records.push({
        op: 'UPSERT', id, station: pick(stations),
        eventTime: new Date(base + Math.floor(rnd() * 90) * 60000).toISOString(),
        temp: Math.round(rnd() * 300) / 10 - 5,
        version,
      });
    } else if (roll < 0.8) {
      // RETRACT：存在的或未知的 ID
      const id = rnd() < 0.8 && liveIds.length ? pick(liveIds) : 'ghost';
      records.push({ op: 'RETRACT', id, version: versions.get(id) || 1 });
    } else {
      // WATERMARK：单调推进，偶发回退
      wmMin += Math.floor(rnd() * 25);
      const ts = rnd() < 0.15 ? wmMin - 5 : wmMin;
      records.push({ op: 'WATERMARK', ts: new Date(base + ts * 60000).toISOString() });
    }
  }
  records.push({ op: 'WATERMARK', ts: new Date(base + 400 * 60000).toISOString() });
  return records;
}

function runStore(records) {
  const store = new SessionStore();
  const sessions = [];
  const errors = [];
  for (const rec of records) {
    if (rec.op === 'WATERMARK') {
      sessions.push(...store.watermark(rec.ts));
    } else {
      const res = rec.op === 'UPSERT' ? store.upsert(rec) : store.retract(rec);
      if (!res.ok) errors.push(res.error);
    }
  }
  return { sessions, errors };
}

for (const seed of [1, 7, 42, 1337, 2026]) {
  test(`差分测试 seed=${seed}（≤40 条记录，枚举参考核对）`, () => {
    const records = generateRecords(seed, 36);
    assert.ok(records.length <= 40);
    const expected = referenceRun(records);
    const actual = runStore(records);
    assert.deepEqual(actual.sessions, expected.sessions);
    assert.deepEqual(actual.errors, expected.errors);
  });
}
