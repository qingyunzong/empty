import { channelsExcluded } from './config.js';
import { imagedRuns } from './state.js';

export function buildRows(state) {
  const occ = [];
  for (const r of imagedRuns(state)) {
    occ.push({ start: r.start, end: r.end, kind: 'imaged', batchId: r.batchId, like: r.like });
  }
  for (const sg of state.segments) {
    const b = state.batches[sg.batchId];
    occ.push({
      start: sg.start,
      end: sg.start + sg.fields,
      kind: 'scan',
      batchId: sg.batchId,
      like: { objective: b.objective, channels: b.channels, group: b.group },
    });
  }
  for (const w of state.maintenance) occ.push({ start: w.start, end: w.end, kind: 'maint', like: null });
  occ.sort((a, b) => a.start - b.start);
  const rows = [];
  let prev = null;
  for (const o of occ) {
    if (prev && o.start > prev.end) rows.push(gapRow(state, prev, o));
    rows.push(o);
    prev = o;
  }
  return rows;
}

function gapRow(state, prev, next) {
  const causes = [];
  if (prev.like && next.like) {
    if (prev.like.objective !== next.like.objective) causes.push('物镜切换');
    if (channelsExcluded(state.config, prev.like.channels, next.like.channels)) causes.push('通道冲洗');
  }
  return { start: prev.end, end: next.start, kind: causes.length ? 'gap:' + causes.join('+') : 'idle', batchId: null, like: null };
}

const pad = (v, n) => String(v).padEnd(n);

export function renderTable(state) {
  const lines = [`机时表 gen=${state.generation} clock=${state.clock}`];
  lines.push(pad('start', 7) + pad('end', 6) + pad('kind', 18) + pad('batch', 8) + pad('group', 9) + pad('objective', 10) + 'channels');
  for (const r of buildRows(state)) {
    lines.push(
      pad(r.start, 7) +
        pad(r.end, 6) +
        pad(r.kind, 18) +
        pad(r.batchId ?? '-', 8) +
        pad(r.like?.group ?? '-', 9) +
        pad(r.like?.objective ?? '-', 10) +
        (r.like ? r.like.channels.join(',') : '-')
    );
  }
  return lines.join('\n');
}
