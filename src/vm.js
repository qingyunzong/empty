import { OP } from './compiler.js';

export class VM {
  constructor(slots) {
    this.slots = slots;
    this.load = new Float64Array(slots);
    this.blocked = new Uint8Array(slots);
  }

  reset() {
    this.load.fill(0);
    this.blocked.fill(0);
  }

  run(code) {
    this.reset();
    for (const ins of code) {
      switch (ins[0]) {
        case OP.BLOCK:
          for (let s = ins[1]; s < ins[2]; s += 1) this.blocked[s] = 1;
          break;
        case OP.ADDRANGE:
          for (let s = ins[1]; s < ins[2]; s += 1) this.load[s] += ins[3];
          break;
        case OP.CHKBLOCK:
          for (let s = 0; s < this.slots; s += 1) {
            if (this.blocked[s] && this.load[s] > 0) {
              return { ok: false, reason: 'maintenance-window', slot: s };
            }
          }
          break;
        case OP.CHKPEAK:
          for (let s = 0; s < this.slots; s += 1) {
            if (this.load[s] > ins[1]) return { ok: false, reason: 'peak-limit', slot: s };
          }
          break;
        case OP.HALT:
          return { ok: true };
        default:
          throw new Error(`vm: unknown opcode ${ins[0]}`);
      }
    }
    return { ok: true };
  }

  peakW() {
    let m = 0;
    for (const v of this.load) if (v > m) m = v;
    return m;
  }
}
