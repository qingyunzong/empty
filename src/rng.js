import { InvalidInputError } from './errors.js';

export class DeterministicRng {
  constructor(seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new InvalidInputError(`seed must be an integer in [0, 4294967295], got: ${seed}`);
    }
    this.state = seed >>> 0;
    this.drawCount = 0;
  }

  nextUint32() {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    const out = (t ^ (t >>> 14)) >>> 0;
    this.drawCount += 1;
    return out;
  }

  nextInt(bound) {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new InvalidInputError(`bound must be a positive integer, got: ${bound}`);
    }
    const limit = Math.floor(0x100000000 / bound) * bound;
    let x = this.nextUint32();
    while (x >= limit) {
      x = this.nextUint32();
    }
    return x % bound;
  }
}
