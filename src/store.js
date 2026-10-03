import fs from 'node:fs';
import path from 'node:path';
import { encodeFrame, scanBuffer, TYPE_DATA, TYPE_COMMIT } from './wal.js';

export const CRASH_POINTS = Object.freeze(['after_data', 'after_sync', 'after_commit']);

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function validateEvent(event) {
  if (event === null || typeof event !== 'object' || Array.isArray(event)) {
    throw new StoreError('E_VALIDATION', 'event must be a JSON object');
  }
  if (typeof event.eventId !== 'string' || event.eventId.length === 0) {
    throw new StoreError('E_VALIDATION', 'event.eventId must be a non-empty string');
  }
  if (typeof event.deviceId !== 'string' || event.deviceId.length === 0) {
    throw new StoreError('E_VALIDATION', 'event.deviceId must be a non-empty string');
  }
  if (!Number.isInteger(event.seq) || event.seq < 0) {
    throw new StoreError('E_VALIDATION', 'event.seq must be a non-negative integer');
  }
  if (event.type !== undefined && typeof event.type !== 'string') {
    throw new StoreError('E_VALIDATION', 'event.type must be a string when present');
  }
}

export class EventStore {
  static open(filePath, options = {}) {
    const existed = fs.existsSync(filePath);
    const fd = fs.openSync(filePath, existed ? 'r+' : 'w+');
    if (!existed) {
      // Persist the directory entry of the newly created WAL file.
      const dirFd = fs.openSync(path.dirname(path.resolve(filePath)), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    }
    const store = new EventStore(fd, filePath, options);
    store.recover();
    return store;
  }

  constructor(fd, filePath, options = {}) {
    this.fd = fd;
    this.path = filePath;
    this.options = options;
  }

  close() {
    fs.closeSync(this.fd);
  }

  // Scans the WAL, truncates the first incomplete/corrupt tail frame and
  // rebuilds the in-memory indexes from committed records only.
  recover() {
    const stat = fs.fstatSync(this.fd);
    const buf = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      read += fs.readSync(this.fd, buf, read, stat.size - read, read);
    }
    const { frames, validBytes } = scanBuffer(buf);
    this.truncatedBytes = stat.size - validBytes;
    if (this.truncatedBytes > 0) {
      fs.ftruncateSync(this.fd, validBytes);
      fs.fsyncSync(this.fd);
    }
    this.size = validBytes;
    this.frames = frames;
    this._rebuildIndex();
    return {
      events: this.events.length,
      frames: frames.length,
      truncatedBytes: this.truncatedBytes,
    };
  }

  _rebuildIndex() {
    const committed = new Set();
    let maxSeq = -1;
    for (const frame of this.frames) {
      if (frame.seq > maxSeq) maxSeq = frame.seq;
      if (frame.type === TYPE_COMMIT) committed.add(frame.seq);
    }
    this.maxSeq = maxSeq;
    this.events = [];
    this.byEventId = new Map();
    this.byDevice = new Map();
    for (const frame of this.frames) {
      if (frame.type !== TYPE_DATA || !committed.has(frame.seq)) continue;
      let event;
      try {
        event = JSON.parse(frame.payload.toString('utf8'));
      } catch {
        throw new StoreError('E_CORRUPT', `committed frame ${frame.seq} has unparseable payload`);
      }
      this._index(event);
    }
  }

  _index(event) {
    this.events.push(event);
    this.byEventId.set(event.eventId, event);
    let perDevice = this.byDevice.get(event.deviceId);
    if (!perDevice) {
      perDevice = new Map();
      this.byDevice.set(event.deviceId, perDevice);
    }
    perDevice.set(event.seq, event);
  }

  _writeAt(buf, position) {
    let written = 0;
    while (written < buf.length) {
      written += fs.writeSync(this.fd, buf, written, buf.length - written, position + written);
    }
  }

  // Appends one event. Durability protocol:
  //   1. write data frame            -> crash point "after_data"
  //   2. fsync data frame            -> crash point "after_sync"
  //   3. write commit frame + fsync  -> crash point "after_commit"
  // A record is visible after recovery iff its commit frame is in the valid
  // prefix of the WAL.
  append(event, { crashAt, onCrash } = {}) {
    validateEvent(event);
    if (this.byEventId.has(event.eventId)) {
      throw new StoreError('E_DUP', `duplicate eventId: ${event.eventId}`);
    }
    const crash = (point) => {
      if (crashAt === point) {
        (onCrash ?? (() => process.exit(70)))(point);
      }
    };
    const walSeq = this.maxSeq + 1;
    const payload = Buffer.from(JSON.stringify(event), 'utf8');

    const dataFrame = encodeFrame(TYPE_DATA, walSeq, payload);
    this._writeAt(dataFrame, this.size);
    this.size += dataFrame.length;
    crash('after_data');

    fs.fsyncSync(this.fd);
    crash('after_sync');

    const commitFrame = encodeFrame(TYPE_COMMIT, walSeq);
    this._writeAt(commitFrame, this.size);
    this.size += commitFrame.length;
    fs.fsyncSync(this.fd);
    crash('after_commit');

    this.frames.push(
      { offset: this.size - dataFrame.length - commitFrame.length, seq: walSeq, type: TYPE_DATA, payload },
      { offset: this.size - commitFrame.length, seq: walSeq, type: TYPE_COMMIT, payload: Buffer.alloc(0) },
    );
    this.maxSeq = walSeq;
    this._index(event);
    return { walSeq };
  }

  get(eventId) {
    return this.byEventId.get(eventId) ?? null;
  }

  // Secondary index lookup: by deviceId, optionally narrowed to an exact seq.
  query(deviceId, seq = undefined) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) {
      throw new StoreError('E_VALIDATION', 'deviceId must be a non-empty string');
    }
    if (seq !== undefined && (!Number.isInteger(seq) || seq < 0)) {
      throw new StoreError('E_VALIDATION', 'seq must be a non-negative integer');
    }
    const perDevice = this.byDevice.get(deviceId);
    if (!perDevice) return [];
    if (seq !== undefined) {
      const event = perDevice.get(seq);
      return event ? [event] : [];
    }
    return [...perDevice.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, event]) => event);
  }

  // All visible events in WAL order.
  all() {
    return [...this.events];
  }
}
