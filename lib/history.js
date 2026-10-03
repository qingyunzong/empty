'use strict';

// 离线更正历史的合并库：事件图(DAG) + 分块记录 + 拓扑索引 + heads。
// 仅使用 Node 标准库。并发/因果完全由父子闭包判定，不依赖任何时钟。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const BEGIN = '-----BEGIN EVENT-----';
const END = '-----END EVENT-----';

class HistoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HistoryError';
    this.code = code;
  }
}

// ---------- 基础工具 ----------

let CRC_TABLE = null;
function crc32(str) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  const buf = Buffer.from(str, 'utf8');
  let crc = 0xffffffff;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// ---------- 分块记录 ----------
// 块字段（固定顺序序列化）：id,type,parents,author,counter,deleted,payload,crc
// crc 覆盖除 crc 行外的全部原始行。

function eventId({ parents, author, counter, payloadB64 }) {
  const p = [...parents].sort().join(',');
  return sha256(['event', p, author, String(counter), payloadB64].join(''));
}

function tombstoneId({ deleted, author, counter }) {
  return sha256(['tombstone', deleted, author, String(counter)].join(''));
}

function blockLines(block) {
  const lines = [`id=${block.id}`, `type=${block.type}`];
  if (block.type === 'event') {
    lines.push(`parents=${[...block.parents].sort().join(',')}`);
    lines.push(`author=${block.author}`);
    lines.push(`counter=${block.counter}`);
    lines.push(`payload=${block.payloadB64}`);
  } else {
    lines.push(`deleted=${block.deleted}`);
    lines.push(`author=${block.author}`);
    lines.push(`counter=${block.counter}`);
  }
  return lines;
}

function serializeBlock(block) {
  const lines = blockLines(block);
  const crc = crc32(lines.join('\n'));
  return [BEGIN, ...lines, `crc=${crc}`, END, ''].join('\n');
}

function parseBlocks(text) {
  const blocks = [];
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === '') { i++; continue; }
    if (lines[i] !== BEGIN) {
      throw new HistoryError('ERR_CORRUPT', `events.log 第 ${i + 1} 行：期望块起始标记`);
    }
    const content = [];
    let crcLine = null;
    i++;
    while (i < lines.length && lines[i] !== END) {
      if (lines[i].startsWith('crc=')) crcLine = lines[i].slice(4);
      else content.push(lines[i]);
      i++;
    }
    if (i >= lines.length) throw new HistoryError('ERR_CORRUPT', 'events.log：块未闭合');
    i++;
    if (crcLine === null) throw new HistoryError('ERR_CORRUPT', '块缺少 CRC');
    if (crc32(content.join('\n')) !== crcLine) {
      throw new HistoryError('ERR_CORRUPT', '块 CRC 校验失败');
    }
    const fields = {};
    for (const line of content) {
      const eq = line.indexOf('=');
      fields[line.slice(0, eq)] = line.slice(eq + 1);
    }
    if (!fields.id || !fields.type) throw new HistoryError('ERR_CORRUPT', '块缺少 id/type');
    if (fields.type === 'event') {
      blocks.push({
        id: fields.id,
        type: 'event',
        parents: fields.parents ? fields.parents.split(',') : [],
        author: fields.author,
        counter: Number(fields.counter),
        payloadB64: fields.payload || '',
        raw: [BEGIN, ...content, `crc=${crcLine}`, END, ''].join('\n'),
      });
    } else if (fields.type === 'tombstone') {
      blocks.push({
        id: fields.id,
        type: 'tombstone',
        deleted: fields.deleted,
        author: fields.author,
        counter: Number(fields.counter),
        raw: [BEGIN, ...content, `crc=${crcLine}`, END, ''].join('\n'),
      });
    } else {
      throw new HistoryError('ERR_CORRUPT', `未知块类型: ${fields.type}`);
    }
  }
  return blocks;
}

// ---------- 历史库 ----------

class History {
  constructor(dir) {
    this.dir = dir;
    this.eventsFile = path.join(dir, 'events.log');
    this.indexFile = path.join(dir, 'index.json');
    this.headsFile = path.join(dir, 'heads.json');
    this.headFile = path.join(dir, 'HEAD');
    this.events = new Map();   // id -> event
    this.tombstones = new Map(); // id -> tombstone
    this.children = new Map(); // id -> [childIds]
    this.order = [];           // 确定性拓扑序
    this.depth = new Map();
    this.counters = new Map(); // author -> 已用最大计数器
    this.headsSet = new Set();
  }

  static init(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const h = new History(dir);
    h._persistAll();
    return h;
  }

  static open(dir) {
    const h = new History(dir);
    h._load();
    return h;
  }

  _load() {
    if (!fs.existsSync(this.eventsFile)) {
      throw new HistoryError('ERR_CORRUPT', `历史不存在: ${this.dir}（先运行 init）`);
    }
    const blocks = parseBlocks(fs.readFileSync(this.eventsFile, 'utf8'));
    for (const b of blocks) {
      if (this.events.has(b.id) || this.tombstones.has(b.id)) {
        throw new HistoryError('ERR_CONFLICT', `重复块 id: ${b.id}`);
      }
      if (b.type === 'event') this.events.set(b.id, b);
      else this.tombstones.set(b.id, b);
    }
    // 校验父引用：必须存在且未被墓碑删除
    for (const ev of this.events.values()) {
      for (const p of ev.parents) {
        if (!this.events.has(p)) {
          const why = this.tombstones.has(p) ? '父事件已被墓碑删除' : '父事件缺失';
          throw new HistoryError('ERR_MISSING_PARENT', `事件 ${ev.id} 的父 ${p}：${why}`);
        }
      }
    }
    this._rebuildGraph();
    this._verifyOrRebuild();
  }

  // 由事件图重建拓扑索引、深度、作者计数器、heads（Kahn 算法，按 id 字典序决胜，保证确定性）
  _rebuildGraph() {
    const indeg = new Map();
    this.children = new Map();
    for (const id of this.events.keys()) { indeg.set(id, 0); this.children.set(id, []); }
    for (const ev of this.events.values()) {
      for (const p of ev.parents) {
        this.children.get(p).push(ev.id);
        indeg.set(ev.id, indeg.get(ev.id) + 1);
      }
    }
    const ready = [...this.events.keys()].filter((id) => indeg.get(id) === 0).sort();
    const order = [];
    const depth = new Map();
    while (ready.length > 0) {
      const id = ready.shift();
      order.push(id);
      const ev = this.events.get(id);
      depth.set(id, ev.parents.length === 0 ? 0 : Math.max(...ev.parents.map((p) => depth.get(p))) + 1);
      for (const c of this.children.get(id)) {
        indeg.set(c, indeg.get(c) - 1);
        if (indeg.get(c) === 0) {
          // 保持 ready 有序以保证确定性
          const pos = ready.findIndex((x) => x > c);
          if (pos === -1) ready.push(c); else ready.splice(pos, 0, c);
        }
      }
    }
    if (order.length !== this.events.size) {
      const remaining = [...this.events.keys()].filter((id) => !order.includes(id));
      throw new HistoryError('ERR_CYCLE', `事件图存在环，涉及: ${remaining.join(', ')}`);
    }
    this.order = order;
    this.depth = depth;
    this.counters = new Map();
    for (const id of order) {
      const ev = this.events.get(id);
      const cur = this.counters.get(ev.author) || 0;
      if (ev.counter > cur) this.counters.set(ev.author, ev.counter);
    }
    this.headsSet = new Set([...this.events.keys()].filter((id) => this.children.get(id).length === 0));
  }

  // 索引 / heads 文件与事件图矛盾时：以事件图为准重建并报告
  _verifyOrRebuild() {
    const rebuilt = [];
    const wantIndex = JSON.stringify({
      order: this.order,
      depth: Object.fromEntries(this.depth),
      counters: Object.fromEntries(this.counters),
    });
    const wantHeads = JSON.stringify({ heads: this.heads() });
    let indexRaw = null;
    let headsRaw = null;
    try { indexRaw = fs.readFileSync(this.indexFile, 'utf8'); } catch {}
    try { headsRaw = fs.readFileSync(this.headsFile, 'utf8'); } catch {}
    if (indexRaw !== wantIndex) rebuilt.push('index');
    if (headsRaw !== wantHeads) rebuilt.push('heads');
    if (rebuilt.length > 0) {
      this._writeFile(this.indexFile, wantIndex);
      this._writeFile(this.headsFile, wantHeads);
      process.stderr.write(JSON.stringify({
        level: 'warn', code: 'REBUILT', rebuilt,
        message: '索引/heads 与事件图矛盾，已按事件图重建',
      }) + '\n');
    }
  }

  _writeFile(file, content) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  }

  _persistAll() {
    if (!fs.existsSync(this.eventsFile)) fs.writeFileSync(this.eventsFile, '');
    this._writeFile(this.indexFile, JSON.stringify({
      order: this.order,
      depth: Object.fromEntries(this.depth),
      counters: Object.fromEntries(this.counters),
    }));
    this._writeFile(this.headsFile, JSON.stringify({ heads: this.heads() }));
  }

  _appendBlock(block) {
    fs.appendFileSync(this.eventsFile, serializeBlock(block));
  }

  _requireEvent(id, what) {
    if (!this.events.has(id)) {
      throw new HistoryError('ERR_HEAD', `${what} 不是已知事件: ${id}`);
    }
    return this.events.get(id);
  }

  // ---------- 公开操作 ----------

  heads() {
    return [...this.headsSet].sort();
  }

  getEvent(id) {
    return this.events.get(id) || null;
  }

  listEvents() {
    return this.order.map((id) => {
      const ev = this.events.get(id);
      return {
        id: ev.id, parents: [...ev.parents].sort(), author: ev.author,
        counter: ev.counter, payload: Buffer.from(ev.payloadB64, 'base64').toString('utf8'),
      };
    });
  }

  // 严格祖先：a 是 b 的祖先（不含自身）。纯父子闭包判定，不用时钟。
  isAncestor(a, b) {
    this._requireEvent(a, 'isAncestor 第一参数');
    this._requireEvent(b, 'isAncestor 第二参数');
    if (a === b) return false;
    const seen = new Set();
    const stack = [b];
    while (stack.length > 0) {
      const cur = stack.pop();
      for (const p of this.events.get(cur).parents) {
        if (p === a) return true;
        if (!seen.has(p)) { seen.add(p); stack.push(p); }
      }
    }
    return false;
  }

  areConcurrent(a, b) {
    return a !== b && !this.isAncestor(a, b) && !this.isAncestor(b, a);
  }

  // 追加更正事件。parents 缺省为当前 heads。相同内容不同 id 不会自动合并。
  append({ author, payload, parents }) {
    if (!author) throw new HistoryError('ERR_HEAD', 'append 需要 author');
    const payloadB64 = Buffer.from(String(payload ?? ''), 'utf8').toString('base64');
    const ps = parents === undefined ? this.heads() : [...parents].sort();
    for (const p of ps) {
      if (!this.events.has(p)) {
        throw new HistoryError('ERR_MISSING_PARENT', `父事件未知或已删除: ${p}`);
      }
    }
    const counter = (this.counters.get(author) || 0) + 1;
    const id = eventId({ parents: ps, author, counter, payloadB64 });
    if (this.events.has(id)) return id; // 同一作者同一计数器的重复提交：幂等
    const block = { id, type: 'event', parents: ps, author, counter, payloadB64 };
    this._appendBlock(block);
    this.events.set(id, block);
    this._rebuildGraph();
    this._persistAll();
    return id;
  }

  // 合并两个 head：确定性、与输入顺序无关、幂等。
  merge(a, b) {
    this._requireEvent(a, 'merge 第一参数');
    this._requireEvent(b, 'merge 第二参数');
    if (a === b) return a;
    if (this.isAncestor(a, b)) return b; // 一方已包含另一方：无需新事件
    if (this.isAncestor(b, a)) return a;
    const ps = [a, b].sort();
    const id = eventId({ parents: ps, author: 'system:merge', counter: 0, payloadB64: '' });
    if (this.events.has(id)) return id;
    const block = { id, type: 'event', parents: ps, author: 'system:merge', counter: 0, payloadB64: '' };
    this._appendBlock(block);
    this.events.set(id, block);
    this._rebuildGraph();
    this._persistAll();
    return id;
  }

  // 检出指定 head：写入 HEAD 指针并重建该 head 视角的更正序列（拓扑序）
  checkout(head) {
    this._requireEvent(head, 'checkout 目标');
    const included = new Set();
    const stack = [head];
    while (stack.length > 0) {
      const cur = stack.pop();
      if (included.has(cur)) continue;
      included.add(cur);
      for (const p of this.events.get(cur).parents) stack.push(p);
    }
    const sequence = this.order.filter((id) => included.has(id)).map((id) => {
      const ev = this.events.get(id);
      return {
        id: ev.id, author: ev.author, counter: ev.counter,
        payload: Buffer.from(ev.payloadB64, 'base64').toString('utf8'),
      };
    });
    this._writeFile(this.headFile, head + '\n');
    return { head, sequence };
  }

  // 撤销：仅允许删除叶子 head，并保留墓碑块
  remove(head, author = 'system:undo') {
    this._requireEvent(head, 'remove 目标');
    if (this.children.get(head).length > 0) {
      throw new HistoryError('ERR_CONFLICT', `只能删除叶子 head；${head} 存在子事件`);
    }
    const counter = (this.counters.get(author) || 0) + 1;
    const tomb = { id: tombstoneId({ deleted: head, author, counter }), type: 'tombstone', deleted: head, author, counter };
    // 重写 events.log：移除被删事件块，追加墓碑块（墓碑永久保留）
    const kept = [];
    for (const id of this.order) {
      if (id !== head) kept.push(serializeBlock(this.events.get(id)));
    }
    for (const t of this.tombstones.values()) kept.push(serializeBlock(t));
    fs.writeFileSync(this.eventsFile, kept.join(''));
    this._appendBlock(tomb);
    this.events.delete(head);
    this.tombstones.set(tomb.id, tomb);
    this._rebuildGraph();
    this._persistAll();
    return tomb.id;
  }
}

module.exports = {
  History, HistoryError, crc32, sha256,
  eventId, tombstoneId, serializeBlock, parseBlocks,
};
