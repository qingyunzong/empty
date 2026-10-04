import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeGraph, decodeIncremental } from './codec.js';
import { emptyGraph, applyChange, writeSetOf } from './graph.js';
import { RouteError, E } from './errors.js';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ':' + canonical(value[k]))
        .join(',') +
      '}'
    );
  }
  return JSON.stringify(value);
}

function hashOf(obj) {
  return createHash('sha256').update(canonical(obj)).digest('hex').slice(0, 16);
}

function sortedObject(map) {
  return Object.fromEntries([...map.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    if (!existsSync(join(dir, 'HEAD'))) {
      throw new RouteError(E.NOT_FOUND, `not a route store: ${dir}`);
    }
  }

  static init(dir) {
    if (existsSync(join(dir, 'HEAD'))) {
      throw new RouteError(E.INVALID, `store already initialized: ${dir}`);
    }
    mkdirSync(join(dir, 'versions'), { recursive: true });
    const graph = emptyGraph();
    const meta = {
      parents: [],
      base: null,
      readSet: [],
      writeSet: [],
      change: {},
      deviceLoad: {},
    };
    const version = hashOf(meta);
    writeFileSync(join(dir, 'versions', `${version}.rtg`), encodeGraph(graph, { ...meta, version }));
    writeFileSync(join(dir, 'HEAD'), version);
    return new Store(dir);
  }

  head() {
    return readFileSync(join(this.dir, 'HEAD'), 'utf8').trim();
  }

  has(version) {
    return existsSync(join(this.dir, 'versions', `${version}.rtg`));
  }

  pathOf(version) {
    return join(this.dir, 'versions', `${version}.rtg`);
  }

  readMeta(version) {
    if (!this.has(version)) {
      throw new RouteError(E.NOT_FOUND, `unknown version: ${version}`);
    }
    const buf = readFileSync(this.pathOf(version));
    const hlen = buf.readUInt32LE(4);
    return JSON.parse(buf.subarray(8, 8 + hlen).toString('utf8'));
  }

  // Full decode; throws E_CORRUPT if any chunk is damaged.
  loadVersion(version) {
    const res = this.decodeVersion(version);
    if (res.error) {
      throw new RouteError(E.CORRUPT, res.error.message, res.error);
    }
    for (const [dev, minutes] of Object.entries(res.meta.deviceLoad ?? {})) {
      graph_setLoad(res.graph, dev, minutes);
    }
    return { meta: res.meta, graph: res.graph };
  }

  // Incremental decode; on corruption the valid prefix stays queryable.
  decodeVersion(version) {
    if (!this.has(version)) {
      throw new RouteError(E.NOT_FOUND, `unknown version: ${version}`);
    }
    const res = decodeIncremental(readFileSync(this.pathOf(version)));
    if (res.meta) {
      for (const [dev, minutes] of Object.entries(res.meta.deviceLoad ?? {})) {
        graph_setLoad(res.graph, dev, minutes);
      }
    }
    return res;
  }

  log() {
    const out = [];
    let cur = this.head();
    while (cur) {
      const meta = this.readMeta(cur);
      out.push({ version: cur, base: meta.base, readSet: meta.readSet, writeSet: meta.writeSet });
      cur = meta.parents[0] ?? null;
    }
    return out;
  }

  // Optimistic commit: the change is rebased onto HEAD. If any node in
  // readSet was written by commits between base and HEAD, the commit is
  // rejected with E_CONFLICT and a stable certificate; no auto-merge.
  commit({ base, readSet = [], change = {} }) {
    const head = this.head();
    if (!this.has(base)) {
      throw new RouteError(E.NOT_FOUND, `unknown base version: ${base}`);
    }
    const sortedRead = [...readSet].sort();
    const writeSet = writeSetOf(change);
    const version = hashOf({ parents: [head], base, readSet: sortedRead, writeSet, change });

    const writesSinceBase = new Set();
    let cur = head;
    let found = false;
    while (cur) {
      if (cur === base) {
        found = true;
        break;
      }
      for (const w of this.readMeta(cur).writeSet ?? []) writesSinceBase.add(w);
      cur = this.readMeta(cur).parents[0] ?? null;
    }
    if (!found) {
      throw new RouteError(E.INVALID, `base ${base} is not an ancestor of HEAD`);
    }

    const conflicted = sortedRead.filter((r) => writesSinceBase.has(r));
    if (conflicted.length > 0) {
      const certificate = {
        code: E.CONFLICT,
        ourVersion: version,
        theirVersion: head,
        readSet: sortedRead,
        conflicted,
        commonAncestor: base,
      };
      throw new RouteError(E.CONFLICT, 'read set conflicts with concurrent commits', {
        certificate,
      });
    }

    const { graph } = this.loadVersion(head);
    applyChange(graph, change);
    const meta = {
      version,
      parents: [head],
      base,
      readSet: sortedRead,
      writeSet,
      change,
      deviceLoad: sortedObject(graph.deviceLoad),
    };
    writeFileSync(this.pathOf(version), encodeGraph(graph, meta));
    writeFileSync(join(this.dir, 'HEAD'), version);
    return { version, meta };
  }
}

function graph_setLoad(graph, dev, minutes) {
  graph.deviceLoad.set(dev, minutes);
}
