import { open, readFile, rename, unlink, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { hashEvent } from './hash.js';
import { brokenChain, revokedConsent } from './errors.js';
import { merkleRoot } from './merkle.js';

export const EVENT_TYPES = ['receive', 'transfer', 'analyze', 'destroy', 'revoke'];
export const ZERO_HASH = '0'.repeat(64);

export const EVENTS_FILE = 'events.jsonl';
export const MANIFEST_FILE = 'manifest.json';

export function computeHash(eventWithoutHash) {
  return hashEvent(eventWithoutHash);
}

export function makeEvent({ seq, type, sampleId = null, consentId = null, data = {}, prevHash, ts }) {
  const base = {
    seq,
    type,
    sampleId,
    consentId,
    data,
    ts: ts ?? new Date().toISOString(),
    prevHash,
  };
  return { ...base, hash: computeHash(base) };
}

export function verifyEvents(events) {
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.seq !== i) {
      throw brokenChain(`event at index ${i} has seq ${e.seq}`, { index: i, expectedSeq: i, actualSeq: e.seq });
    }
    const expectedPrev = i === 0 ? ZERO_HASH : events[i - 1].hash;
    if (e.prevHash !== expectedPrev) {
      throw brokenChain(`event at index ${i} has broken prevHash linkage`, { index: i, expectedPrev, actualPrev: e.prevHash });
    }
    const { hash, ...rest } = e;
    const recomputed = computeHash(rest);
    if (recomputed !== hash) {
      throw brokenChain(`event at index ${i} fails hash recomputation`, { index: i, expectedHash: recomputed, actualHash: hash });
    }
  }
  return true;
}

export function revokedConsentIds(events) {
  const revoked = new Set();
  for (const e of events) {
    if (e.type === 'revoke' && e.consentId) revoked.add(e.consentId);
  }
  return revoked;
}

export function annotateRestricted(events) {
  const revoked = revokedConsentIds(events);
  return events.map((e) => ({ ...e, restricted: e.consentId !== null && revoked.has(e.consentId) }));
}

export class Chain {
  constructor(dir, events, manifest) {
    this.dir = dir;
    this.events = events;
    this.manifest = manifest;
  }

  static async open(dir) {
    await mkdir(dir, { recursive: true });
    const eventsPath = path.join(dir, EVENTS_FILE);
    const manifestPath = path.join(dir, MANIFEST_FILE);

    let raw = '';
    try {
      raw = await readFile(eventsPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    const lines = raw.split('\n');
    const events = [];
    let torn = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        torn = true;
        break;
      }
      events.push(parsed);
    }

    let truncatedAt = null;
    try {
      verifyEvents(events);
    } catch (err) {
      if (err.code !== 'BROKEN_CHAIN') throw err;
      truncatedAt = err.details.index;
      events.length = truncatedAt;
    }

    let manifest = null;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
    }

    const recovered = torn || truncatedAt !== null;
    const chain = new Chain(dir, events, manifest);
    await chain.#reconcileManifest();
    if (recovered) await chain.#rewriteEvents();
    await chain.#cleanTmpFiles();
    return chain;
  }

  async #reconcileManifest() {
    const m = this.manifest;
    if (!m) return;
    const valid =
      Number.isInteger(m.seq) &&
      m.seq >= 0 &&
      m.seq < this.events.length &&
      this.events[m.seq].hash === m.headHash &&
      merkleRoot(this.events.slice(0, m.seq + 1).map((e) => e.hash)) === m.merkleRoot;
    if (!valid) {
      this.manifest = null;
      await unlink(path.join(this.dir, MANIFEST_FILE)).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
  }

  async #rewriteEvents() {
    const eventsPath = path.join(this.dir, EVENTS_FILE);
    const tmpPath = eventsPath + '.rewrite.tmp';
    const fh = await open(tmpPath, 'w');
    try {
      for (const e of this.events) await fh.write(JSON.stringify(e) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmpPath, eventsPath);
    await fsyncDir(this.dir);
  }

  async #cleanTmpFiles() {
    let names;
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      if (name.endsWith('.tmp')) {
        await unlink(path.join(this.dir, name)).catch((err) => {
          if (err.code !== 'ENOENT') throw err;
        });
      }
    }
  }

  get head() {
    if (this.events.length === 0) return null;
    const e = this.events[this.events.length - 1];
    return { seq: e.seq, hash: e.hash };
  }

  get merkleRoot() {
    return merkleRoot(this.events.map((e) => e.hash));
  }

  leafHashes() {
    return this.events.map((e) => e.hash);
  }

  isRevoked(consentId) {
    return this.events.some((e) => e.type === 'revoke' && e.consentId === consentId);
  }

  async append({ type, sampleId = null, consentId = null, data = {}, ts }) {
    if (!EVENT_TYPES.includes(type)) {
      throw new Error(`unknown event type: ${type} (expected one of ${EVENT_TYPES.join(', ')})`);
    }
    if (type !== 'revoke' && consentId !== null && this.isRevoked(consentId)) {
      throw revokedConsent(`consent '${consentId}' has been revoked; refusing new ${type} event`, {
        consentId,
        type,
      });
    }
    const seq = this.events.length;
    const prevHash = seq === 0 ? ZERO_HASH : this.events[seq - 1].hash;
    const event = makeEvent({ seq, type, sampleId, consentId, data, prevHash, ts });
    const fh = await open(path.join(this.dir, EVENTS_FILE), 'a');
    try {
      await fh.write(JSON.stringify(event) + '\n');
      await fh.sync();
    } finally {
      await fh.close();
    }
    this.events.push(event);
    return event;
  }

  list() {
    return annotateRestricted(this.events);
  }

  verify() {
    return verifyEvents(this.events);
  }
}

async function fsyncDir(dir) {
  const fh = await open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}

export { fsyncDir };
