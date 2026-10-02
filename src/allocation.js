import { Fraction } from './fraction.js';
import { Rect } from './rect.js';

export class TransactionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TransactionError';
  }
}

function cloneMap(map) {
  return new Map([...map].map(([key, rects]) => [key, rects.slice()]));
}

// Allocation engine: devices own surface rectangles, defects are rectangles
// that can be moved / scaled / split. Every mutation is a transaction: on
// illegal coordinates or empty rectangles the state is rolled back and the
// undo/redo stacks are left untouched.
export class AllocationEngine {
  #devices = new Map();
  #defects = new Map();
  #undoStack = [];
  #redoStack = [];

  get undoDepth() {
    return this.#undoStack.length;
  }

  get redoDepth() {
    return this.#redoStack.length;
  }

  deviceIds() {
    return [...this.#devices.keys()];
  }

  defectIds() {
    return [...this.#defects.keys()];
  }

  defectBlocks(id) {
    const rects = this.#defects.get(id);
    if (!rects) throw new TransactionError(`unknown defect "${id}"`);
    return rects.slice();
  }

  #snapshot() {
    return { devices: cloneMap(this.#devices), defects: cloneMap(this.#defects) };
  }

  #restore(snapshot) {
    this.#devices = snapshot.devices;
    this.#defects = snapshot.defects;
  }

  #validate() {
    for (const [kind, map] of [['device', this.#devices], ['defect', this.#defects]]) {
      for (const [id, rects] of map) {
        for (const rect of rects) {
          if (rect.isEmpty) {
            throw new TransactionError(`${kind} "${id}" would contain an empty rectangle`);
          }
        }
      }
    }
  }

  #transact(mutate) {
    const snapshot = this.#snapshot();
    let result;
    try {
      result = mutate();
      this.#validate();
    } catch (err) {
      this.#restore(snapshot);
      return { ok: false, error: err.message };
    }
    this.#undoStack.push(snapshot);
    this.#redoStack = [];
    return { ok: true, result };
  }

  addDevice(id, rectSpec) {
    return this.#transact(() => {
      const rect = Rect.from(rectSpec);
      if (rect.isEmpty) throw new TransactionError(`device "${id}" rectangle is empty`);
      const rects = this.#devices.get(id) ?? [];
      rects.push(rect);
      this.#devices.set(id, rects);
    });
  }

  removeDevice(id) {
    return this.#transact(() => {
      if (!this.#devices.delete(id)) throw new TransactionError(`unknown device "${id}"`);
    });
  }

  addDefect(id, rectSpec) {
    return this.#transact(() => {
      const rect = Rect.from(rectSpec);
      if (rect.isEmpty) throw new TransactionError(`defect "${id}" rectangle is empty`);
      const rects = this.#defects.get(id) ?? [];
      rects.push(rect);
      this.#defects.set(id, rects);
    });
  }

  removeDefect(id) {
    return this.#transact(() => {
      if (!this.#defects.delete(id)) throw new TransactionError(`unknown defect "${id}"`);
    });
  }

  moveDefect(id, dx, dy) {
    return this.#transact(() => {
      const rects = this.#defects.get(id);
      if (!rects) throw new TransactionError(`unknown defect "${id}"`);
      const fx = Fraction.parse(dx);
      const fy = Fraction.parse(dy);
      this.#defects.set(id, rects.map((rect) => rect.translate(fx, fy)));
    });
  }

  scaleDefect(id, sx, sy) {
    return this.#transact(() => {
      const rects = this.#defects.get(id);
      if (!rects) throw new TransactionError(`unknown defect "${id}"`);
      const fx = Fraction.parse(sx);
      const fy = Fraction.parse(sy);
      if (fx.sign() <= 0 || fy.sign() <= 0) {
        throw new TransactionError('scale factors must be positive');
      }
      this.#defects.set(id, rects.map((rect) => rect.scale(fx, fy)));
    });
  }

  // Splits block `blockIndex` of defect `id` at coordinate `at` along `axis`
  // ("x" -> vertical cut, "y" -> horizontal cut). The cut must lie strictly
  // inside the block, otherwise one side would be empty and we roll back.
  splitDefect(id, axis, at, blockIndex = 0) {
    return this.#transact(() => {
      const rects = this.#defects.get(id);
      if (!rects) throw new TransactionError(`unknown defect "${id}"`);
      if (blockIndex < 0 || blockIndex >= rects.length) {
        throw new TransactionError(`defect "${id}" has no block ${blockIndex}`);
      }
      const cut = Fraction.parse(at);
      const block = rects[blockIndex];
      let first;
      let second;
      if (axis === 'x') {
        if (cut.cmp(block.x1) <= 0 || cut.cmp(block.x2) >= 0) {
          throw new TransactionError('split coordinate must lie strictly inside the block');
        }
        first = new Rect(block.x1, block.y1, cut, block.y2);
        second = new Rect(cut, block.y1, block.x2, block.y2);
      } else if (axis === 'y') {
        if (cut.cmp(block.y1) <= 0 || cut.cmp(block.y2) >= 0) {
          throw new TransactionError('split coordinate must lie strictly inside the block');
        }
        first = new Rect(block.x1, block.y1, block.x2, cut);
        second = new Rect(block.x1, cut, block.x2, block.y2);
      } else {
        throw new TransactionError(`axis must be "x" or "y", got ${JSON.stringify(axis)}`);
      }
      const next = rects.slice();
      next.splice(blockIndex, 1, first, second);
      this.#defects.set(id, next);
      return { blocks: next.length };
    });
  }

  undo() {
    if (this.#undoStack.length === 0) return { ok: false, error: 'nothing to undo' };
    this.#redoStack.push(this.#snapshot());
    this.#restore(this.#undoStack.pop());
    return { ok: true };
  }

  redo() {
    if (this.#redoStack.length === 0) return { ok: false, error: 'nothing to redo' };
    this.#undoStack.push(this.#snapshot());
    this.#restore(this.#redoStack.pop());
    return { ok: true };
  }

  // Overlap certificate for one device rectangle against one defect block.
  static certificate(overlap) {
    return {
      xInterval: [overlap.x1, overlap.x2],
      yInterval: [overlap.y1, overlap.y2],
      area: overlap.area(),
    };
  }

  // For every defect block: per-device overlap area, total overlapped area,
  // responsibility ratio (area / totalArea), and the full set of devices tied
  // for the maximum ratio. Devices with zero overlap (e.g. only sharing an
  // edge) are excluded entirely.
  report() {
    const blocks = [];
    for (const [defectId, rects] of this.#defects) {
      rects.forEach((block, blockIndex) => {
        const devices = [];
        let totalArea = Fraction.ZERO;
        for (const [deviceId, deviceRects] of this.#devices) {
          let area = Fraction.ZERO;
          const certificates = [];
          for (const deviceRect of deviceRects) {
            const overlap = deviceRect.intersect(block);
            if (overlap) {
              area = area.add(overlap.area());
              certificates.push(AllocationEngine.certificate(overlap));
            }
          }
          if (!area.isZero()) {
            devices.push({ deviceId, area, certificates });
            totalArea = totalArea.add(area);
          }
        }
        let maxRatio = null;
        const responsible = [];
        for (const entry of devices) {
          entry.ratio = entry.area.div(totalArea);
          if (maxRatio === null || entry.ratio.cmp(maxRatio) > 0) {
            maxRatio = entry.ratio;
            responsible.length = 0;
            responsible.push(entry.deviceId);
          } else if (entry.ratio.cmp(maxRatio) === 0) {
            responsible.push(entry.deviceId);
          }
        }
        blocks.push({
          defectId,
          blockIndex,
          rect: block,
          defectArea: block.area(),
          totalArea,
          devices,
          responsible,
        });
      });
    }
    return { blocks };
  }
}
