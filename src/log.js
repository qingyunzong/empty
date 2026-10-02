// Append-only log with integrity checks.
//  - ERR_GAP:   caller-supplied seq is not the next expected sequence number
//  - ERR_CLOCK: per-source timestamps must be non-decreasing
export class LogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LogError';
    this.code = code;
  }
}

export class AppendOnlyLog {
  #records = [];
  #lastTsBySrc = new Map();

  append(record) {
    const seq = this.#records.length;
    if (record.seq !== undefined && record.seq !== seq) {
      throw new LogError(
        'ERR_GAP',
        `log gap: expected seq ${seq}, got ${record.seq}`,
      );
    }
    if (record.ts !== undefined && record.src !== undefined) {
      const last = this.#lastTsBySrc.get(record.src);
      if (last !== undefined && record.ts < last) {
        throw new LogError(
          'ERR_CLOCK',
          `clock inversion for src "${record.src}": ts ${record.ts} < ${last}`,
        );
      }
      this.#lastTsBySrc.set(record.src, record.ts);
    }
    const stored = Object.freeze({ ...record, seq });
    this.#records.push(stored);
    return stored;
  }

  get records() {
    return this.#records.slice();
  }

  get size() {
    return this.#records.length;
  }
}
