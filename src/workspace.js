'use strict';

const { Frac } = require('./fraction.js');
const { Rect, overlapCertificate } = require('./geometry.js');

class Workspace {
  constructor() {
    this.devices = new Map(); // id -> Rect[]
    this.defects = new Map(); // id -> Rect
    this.undoStack = [];
    this.redoStack = [];
  }

  static fromSpec(spec) {
    const ws = new Workspace();
    for (const d of spec.devices || []) {
      if (typeof d.id !== 'string' || d.id === '') throw new TypeError('device id must be a non-empty string');
      if (!Array.isArray(d.rects) || d.rects.length === 0) throw new TypeError(`device ${d.id} needs a non-empty rects array`);
      const rects = d.rects.map(Rect.fromArray);
      for (const r of rects) {
        if (!r.isValid()) throw new RangeError(`device ${d.id} has empty/invalid rect ${JSON.stringify(r.toArray())}`);
      }
      if (ws.devices.has(d.id)) throw new RangeError(`duplicate device id ${d.id}`);
      ws.devices.set(d.id, rects);
    }
    for (const d of spec.defects || []) {
      ws._addDefect(d.id, Rect.fromArray(d.rect));
    }
    return ws;
  }

  _addDefect(id, rect) {
    if (typeof id !== 'string' || id === '') throw new TypeError('defect id must be a non-empty string');
    if (this.defects.has(id)) throw new RangeError(`duplicate defect id ${id}`);
    if (!rect.isValid()) throw new RangeError(`defect ${id} has empty/invalid rect ${JSON.stringify(rect.toArray())}`);
    this.defects.set(id, rect);
  }

  snapshot() {
    // Rects are immutable, so copying the map structure (and device rect
    // arrays) is sufficient for a restorable snapshot.
    const devices = new Map();
    for (const [k, v] of this.devices) devices.set(k, v.slice());
    return { devices, defects: new Map(this.defects) };
  }

  _restore(snap) {
    this.devices = snap.devices;
    this.defects = snap.defects;
  }

  // Every mutation runs as a transaction: on invalid coordinates or empty
  // rectangles the state is rolled back and the undo stack is untouched.
  transact(fn) {
    const before = this.snapshot();
    try {
      fn();
      this._validate();
    } catch (err) {
      this._restore(before);
      const e = new Error(`transaction rolled back: ${err.message}`);
      e.cause = err;
      e.rolledBack = true;
      throw e;
    }
    this.undoStack.push(before);
    this.redoStack.length = 0;
  }

  _validate() {
    for (const [id, rects] of this.devices) {
      for (const r of rects) {
        if (!r.isValid()) throw new RangeError(`device ${id} has empty/invalid rect ${JSON.stringify(r.toArray())}`);
      }
    }
    for (const [id, r] of this.defects) {
      if (!r.isValid()) throw new RangeError(`defect ${id} has empty/invalid rect ${JSON.stringify(r.toArray())}`);
    }
  }

  _defectRect(id) {
    const r = this.defects.get(id);
    if (!r) throw new RangeError(`unknown defect id ${id}`);
    return r;
  }

  moveDefect(id, dx, dy) {
    this.transact(() => {
      this.defects.set(id, this._defectRect(id).translate(Frac.from(dx), Frac.from(dy)));
    });
  }

  scaleDefect(id, factor, anchor) {
    this.transact(() => {
      const r = this._defectRect(id);
      const a = anchor === 'min' ? { x: r.x1, y: r.y1 }
        : anchor === undefined || anchor === 'center' ? r.center()
        : { x: Frac.from(anchor.x), y: Frac.from(anchor.y) };
      this.defects.set(id, r.scale(factor, a));
    });
  }

  // Split defect `id` perpendicular to `axis` at coordinate `at`.
  // The piece below/left of the cut keeps `id`; the other gets `newId`.
  splitDefect(id, axis, at, newId) {
    this.transact(() => {
      const r = this._defectRect(id);
      const cut = Frac.from(at);
      const nid = newId === undefined ? `${id}#2` : newId;
      if (typeof nid !== 'string' || nid === '') throw new TypeError('newId must be a non-empty string');
      if (this.defects.has(nid)) throw new RangeError(`defect id ${nid} already exists`);
      let first;
      let second;
      if (axis === 'x') {
        first = new Rect(r.x1, r.y1, cut, r.y2);
        second = new Rect(cut, r.y1, r.x2, r.y2);
      } else if (axis === 'y') {
        first = new Rect(r.x1, r.y1, r.x2, cut);
        second = new Rect(r.x1, cut, r.x2, r.y2);
      } else {
        throw new TypeError(`split axis must be "x" or "y", got ${JSON.stringify(axis)}`);
      }
      if (!first.isValid() || !second.isValid()) {
        throw new RangeError(`split at ${cut} produces an empty rectangle`);
      }
      this.defects.set(id, first);
      this.defects.set(nid, second);
    });
  }

  undo() {
    if (this.undoStack.length === 0) return false;
    this.redoStack.push(this.snapshot());
    this._restore(this.undoStack.pop());
    return true;
  }

  redo() {
    if (this.redoStack.length === 0) return false;
    this.undoStack.push(this.snapshot());
    this._restore(this.redoStack.pop());
    return true;
  }

  // Per-defect overlap areas, total area, responsibility ratios and the full
  // set of tied max-responsibility devices, all as exact fractions.
  report() {
    const defects = [];
    for (const [defectId, defectRect] of this.defects) {
      const totalArea = defectRect.area();
      const entries = [];
      for (const [deviceId, rects] of this.devices) {
        let overlap = Frac.zero();
        const pieces = [];
        for (const r of rects) {
          const inter = defectRect.intersect(r);
          if (inter !== null) {
            overlap = overlap.add(inter.area());
            pieces.push(inter);
          }
        }
        entries.push({ deviceId, overlap, pieces });
      }
      const positive = entries.filter((e) => e.overlap.isPositive());
      let maxRatio = null;
      const withRatio = positive.map((e) => {
        const ratio = e.overlap.div(totalArea);
        if (maxRatio === null || ratio.gt(maxRatio)) maxRatio = ratio;
        return { ...e, ratio };
      });
      // All devices tied at the maximum ratio are reported; never pick one.
      const responsible = withRatio
        .filter((e) => e.ratio.eq(maxRatio))
        .map((e) => e.deviceId)
        .sort();
      const allRects = [defectRect];
      for (const rects of this.devices.values()) allRects.push(...rects);
      defects.push({
        id: defectId,
        rect: defectRect.toArray(),
        totalArea: totalArea.toString(),
        devices: withRatio.map((e) => ({
          deviceId: e.deviceId,
          overlapArea: e.overlap.toString(),
          ratio: e.ratio.toString(),
        })),
        responsible,
        certificates: withRatio.flatMap((e) =>
          e.pieces.map((p) => ({ deviceId: e.deviceId, ...overlapCertificate(p, allRects) }))),
      });
    }
    return { defects };
  }
}

module.exports = { Workspace };
