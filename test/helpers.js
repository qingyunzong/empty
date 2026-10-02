import assert from 'node:assert/strict';
import { imagedRuns } from '../src/state.js';
import { gapBetween } from '../src/scheduler.js';

export function validateTimeline(state) {
  const cfg = state.config;
  const occ = [];
  for (const r of imagedRuns(state)) occ.push({ start: r.start, end: r.end, kind: 'imaged', like: r.like });
  for (const sg of state.segments) {
    const b = state.batches[sg.batchId];
    occ.push({ start: sg.start, end: sg.start + sg.fields, kind: 'scan', like: { objective: b.objective, channels: b.channels } });
  }
  for (const w of state.maintenance) occ.push({ start: w.start, end: w.end, kind: 'maint', like: null });
  occ.sort((a, b) => a.start - b.start);
  for (let i = 0; i < occ.length; i++) {
    assert.ok(occ[i].start >= 0 && occ[i].end <= cfg.horizon, '占用越界');
    if (i > 0) {
      const prev = occ[i - 1];
      assert.ok(prev.end <= occ[i].start, `占用重叠: ${JSON.stringify(prev)} vs ${JSON.stringify(occ[i])}`);
      if (prev.kind !== 'maint' && occ[i].kind !== 'maint' && prev.like && occ[i].like) {
        const need = gapBetween(cfg, prev.like, occ[i].like);
        assert.ok(occ[i].start - prev.end >= need, `互斥/切换间隔被侵犯: ${prev.end} -> ${occ[i].start} 需 ${need}`);
      }
    }
  }
  for (const b of Object.values(state.batches)) {
    if (b.status !== 'pending') continue;
    const sum = state.segments.filter((s) => s.batchId === b.id).reduce((m, s) => m + s.fields, 0);
    assert.equal(sum, b.fieldsTotal - b.fieldsImaged, `批次 ${b.id} 段与视野不一致`);
  }
}
