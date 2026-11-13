export class ManualClock {
  #milliseconds: number;

  constructor(milliseconds = 0) {
    this.#milliseconds = milliseconds;
  }

  readonly now = (): number => {
    return this.#milliseconds;
  };

  read(): number {
    return this.#milliseconds;
  }

  set(milliseconds: number): number {
    this.#milliseconds = milliseconds;
    return this.#milliseconds;
  }

  advance(milliseconds: number): number {
    this.#milliseconds += milliseconds;
    return this.#milliseconds;
  }
}

export {
  ManualClock as TestClock,
  ManualClock as FakeClock,
  ManualClock as ControllableClock,
};
