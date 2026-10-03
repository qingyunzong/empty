// 压缩位置倒排索引：短语查询 + 近邻查询，支持增量移除。
// 压缩方式：posting 序列化时，位置列表做差分（gap）后 varint 编码。

export function tokenize(text) {
  // 英文/数字连续串为一个 token；表意文字（如中文）逐字为 token。
  return String(text ?? '').toLowerCase().match(/[a-z0-9]+|\p{Lo}/gu) ?? [];
}

function writeVarint(out, n) {
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
}

function readVarint(buf, offset) {
  let result = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result >>> 0, pos];
}

function encodePosting(docs) {
  // docs: Array<[docId, number[] positions]>，positions 已升序
  const bytes = [];
  writeVarint(bytes, docs.length);
  for (const [docId, positions] of docs) {
    const idBytes = Buffer.from(String(docId), 'utf8');
    writeVarint(bytes, idBytes.length);
    for (const b of idBytes) bytes.push(b);
    writeVarint(bytes, positions.length);
    let prev = 0;
    for (const p of positions) {
      writeVarint(bytes, p - prev);
      prev = p;
    }
  }
  return Buffer.from(bytes).toString('base64');
}

function decodePosting(b64) {
  const buf = Buffer.from(b64, 'base64');
  let offset = 0;
  const docs = [];
  let count;
  [count, offset] = readVarint(buf, offset);
  for (let i = 0; i < count; i++) {
    let len;
    [len, offset] = readVarint(buf, offset);
    const docId = buf.subarray(offset, offset + len).toString('utf8');
    offset += len;
    let posCount;
    [posCount, offset] = readVarint(buf, offset);
    const positions = [];
    let prev = 0;
    for (let j = 0; j < posCount; j++) {
      let gap;
      [gap, offset] = readVarint(buf, offset);
      prev += gap;
      positions.push(prev);
    }
    docs.push([docId, positions]);
  }
  return docs;
}

// 在升序数组中找第一个 >= target 的下标，不存在返回 -1
function lowerBound(arr, target) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo < arr.length ? lo : -1;
}

export class PositionalIndex {
  constructor() {
    // term -> Map(docId -> number[] positions)
    this.postings = new Map();
  }

  static deserialize(data) {
    const idx = new PositionalIndex();
    for (const [term, b64] of Object.entries(data ?? {})) {
      const m = new Map();
      for (const [docId, positions] of decodePosting(b64)) m.set(docId, positions);
      idx.postings.set(term, m);
    }
    return idx;
  }

  serialize() {
    const out = {};
    for (const [term, m] of this.postings) {
      const docs = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
      out[term] = encodePosting(docs);
    }
    return out;
  }

  addDocument(docId, text) {
    this.removeDocument(docId);
    const tokens = tokenize(text);
    tokens.forEach((tok, pos) => {
      let m = this.postings.get(tok);
      if (!m) this.postings.set(tok, (m = new Map()));
      let arr = m.get(docId);
      if (!arr) m.set(docId, (arr = []));
      arr.push(pos);
    });
  }

  // 增量移除：仅摘除该文档的 posting，不重建索引
  removeDocument(docId) {
    for (const [term, m] of this.postings) {
      if (m.delete(docId) && m.size === 0) this.postings.delete(term);
    }
  }

  docCount() {
    const s = new Set();
    for (const m of this.postings.values()) for (const d of m.keys()) s.add(d);
    return s.size;
  }

  // 短语查询：返回 Map(docId -> [起始位置...])
  phrase(text) {
    const tokens = tokenize(text);
    const result = new Map();
    if (tokens.length === 0) return result;
    const first = this.postings.get(tokens[0]);
    if (!first) return result;
    const rest = tokens.slice(1).map((t) => this.postings.get(t));
    if (rest.some((m) => !m)) return result;
    for (const [docId, starts] of first) {
      const hits = [];
      for (const s of starts) {
        let ok = true;
        for (let i = 0; i < rest.length; i++) {
          const arr = rest[i].get(docId);
          if (!arr || !arr.includes(s + i + 1)) { ok = false; break; }
        }
        if (ok) hits.push(s);
      }
      if (hits.length) result.set(docId, hits);
    }
    return result;
  }

  // 近邻查询：以首词位置 s 为起点，若其余每个词在 [s, s+k-1] 内均有出现，
  // 记一次命中；end 为各词自 s 起首次出现位置的最大值。
  // 返回 Map(docId -> [{start, end}...])
  near(text, k) {
    const tokens = [...new Set(tokenize(text))];
    const result = new Map();
    if (tokens.length === 0 || k < tokens.length) return result;
    const lists = tokens.map((t) => this.postings.get(t));
    if (lists.some((m) => !m)) return result;
    for (const [docId, starts] of lists[0]) {
      const hits = [];
      const otherLists = lists.slice(1).map((m) => m.get(docId)).filter(Boolean);
      if (otherLists.length !== lists.length - 1) continue;
      for (const s of starts) {
        let end = s;
        let ok = true;
        for (const arr of otherLists) {
          const i = lowerBound(arr, s);
          if (i === -1 || arr[i] > s + k - 1) { ok = false; break; }
          if (arr[i] > end) end = arr[i];
        }
        if (ok) hits.push({ start: s, end });
      }
      if (hits.length) result.set(docId, hits);
    }
    return result;
  }
}
