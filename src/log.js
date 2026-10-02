// 分段持久化命令日志。
// 每批(commit)三段写:
//   1. seg-NNNNNN.data    记录(JSONL) + CRC 尾行
//   2. seg-NNNNNN.commit  提交标记: "<count> <crc>"
//   3. manifest.json      已提交段清单
// 崩溃恢复规则:
//   - 写完 data 未写 commit      -> 丢弃该批(半批不生效)
//   - 写完 commit 未写 manifest  -> 整批可见(commit 为权威, 重建 manifest)
//   - data/commit 校验失败       -> ERR_CORRUPT, 标识坏段
import fs from 'node:fs';
import path from 'node:path';
import { crc32hex } from './crc32.js';

const SEG_RE = /^seg-(\d{6})\.data$/;

function dataPath(dir, id) { return path.join(dir, `seg-${String(id).padStart(6, '0')}.data`); }
function commitPath(dir, id) { return path.join(dir, `seg-${String(id).padStart(6, '0')}.commit`); }
function manifestPath(dir) { return path.join(dir, 'manifest.json'); }

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(dir), 'utf8'));
  } catch {
    return { committed: [] };
  }
}

function nextSegmentId(dir) {
  let max = 0;
  for (const f of fs.readdirSync(dir)) {
    const m = SEG_RE.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export class SegmentLog {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.batch = [];
  }

  append(record) {
    this.batch.push({ ...record });
  }

  cmd(name) {
    this.append({ type: 'cmd', name });
  }

  ack(sensor, value = 'OK') {
    this.append({ type: 'ack', sensor, value });
  }

  // fault: 'after-data' | 'after-commit' 模拟掉电, 在对应阶段后停止。
  commit({ fault = null } = {}) {
    if (this.batch.length === 0) return null;
    const id = nextSegmentId(this.dir);
    const records = this.batch;
    const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
    const crc = crc32hex(body);
    fs.writeFileSync(dataPath(this.dir, id), body + `CRC ${crc}\n`);
    if (fault === 'after-data') {
      this.batch = [];
      return { id, crashed: true, stage: 'data' };
    }
    fs.writeFileSync(commitPath(this.dir, id), `${records.length} ${crc}\n`);
    if (fault === 'after-commit') {
      this.batch = [];
      return { id, crashed: true, stage: 'commit' };
    }
    const manifest = readManifest(this.dir);
    manifest.committed.push(id);
    fs.writeFileSync(manifestPath(this.dir), JSON.stringify(manifest) + '\n');
    this.batch = [];
    return { id, crashed: false };
  }
}

export function recover(dir) {
  const manifest = readManifest(dir);
  const committedSet = new Set(manifest.committed);
  const segments = [];
  const errors = [];
  const records = [];
  let manifestRebuilt = false;

  const ids = fs.readdirSync(dir)
    .map((f) => SEG_RE.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);

  for (const id of ids) {
    const raw = fs.readFileSync(dataPath(dir, id), 'utf8');
    const lines = raw.split('\n');
    // 尾行必须是 CRC 行, 且与正文校验一致
    const tail = lines.length >= 2 ? lines[lines.length - 2] : null;
    const tailMatch = tail !== null && /^CRC ([0-9a-f]{8})$/.exec(tail);
    const body = lines.slice(0, -2).join('\n') + (lines.length > 2 ? '\n' : '');
    if (!tailMatch || lines[lines.length - 1] !== '' || crc32hex(body) !== tailMatch[1]) {
      errors.push({ code: 'ERR_CORRUPT', segment: id, detail: 'data checksum mismatch or truncation' });
      segments.push({ id, status: 'corrupt' });
      continue;
    }
    let parsed;
    try {
      parsed = lines.slice(0, -2).map((l) => JSON.parse(l));
    } catch {
      errors.push({ code: 'ERR_CORRUPT', segment: id, detail: 'unparseable record' });
      segments.push({ id, status: 'corrupt' });
      continue;
    }
    // 无 commit -> 掉电于 data 之后, 丢弃该批
    let commitLine = null;
    try { commitLine = fs.readFileSync(commitPath(dir, id), 'utf8').trim(); } catch { /* missing */ }
    if (commitLine === null) {
      segments.push({ id, status: 'discarded' });
      continue;
    }
    if (commitLine !== `${parsed.length} ${crc32hex(body)}`) {
      errors.push({ code: 'ERR_CORRUPT', segment: id, detail: 'commit marker mismatch' });
      segments.push({ id, status: 'corrupt' });
      continue;
    }
    // commit 为权威: 即使 manifest 缺失(掉电于 commit 之后)也整批可见
    if (!committedSet.has(id)) manifestRebuilt = true;
    segments.push({ id, status: 'visible' });
    records.push(...parsed);
  }

  if (manifestRebuilt) {
    const visible = segments.filter((s) => s.status === 'visible').map((s) => s.id);
    fs.writeFileSync(manifestPath(dir), JSON.stringify({ committed: visible }) + '\n');
  }

  return { records, segments, errors, manifestRebuilt };
}
