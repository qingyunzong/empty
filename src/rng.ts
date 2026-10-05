/**
 * Deterministic, fully serializable PRNG (mulberry32).
 * The whole generator state is a single uint32, so a snapshot only
 * needs to store one number to replay the stream exactly.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  nextFloat(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive +
      Math.floor(this.nextFloat() * (maxInclusive - minInclusive + 1))
    );
  }

  getState(): number {
    return this.state;
  }

  static fromState(state: number): Rng {
    const rng = new Rng(1);
    rng.state = state >>> 0;
    return rng;
  }
}
