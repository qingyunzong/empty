/**
 * secret-scan: chunk-safe secret scanning over bounded byte patterns.
 *
 * Core ideas
 * ----------
 * - Patterns are "finite byte patterns": every pattern declares `maxLength`,
 *   an upper bound on the byte length of any match it can produce. The
 *   scanner verifies this bound at runtime and throws if it is exceeded.
 * - Input is treated as a byte string (each byte maps to one latin1 code
 *   unit), so reported offsets are always exact byte offsets into the
 *   original input, regardless of chunking.
 * - Streaming scans retain `maxSecretLength + maxWhitelistLength` bytes
 *   across chunk boundaries. A match is only finalized once the retained
 *   window guarantees no remaining byte can extend it, so matches that span
 *   chunk boundaries are never missed, truncated, or reported twice.
 * - A whitelist range suppresses a match only when the match is *fully
 *   contained* in the range; partial overlap never suppresses.
 * - Matches from different patterns whose ranges overlap are merged into a
 *   single finding that lists every contributing pattern.
 */

export interface BytePattern {
  /** Human-readable name reported with each match. */
  name: string;
  /** Regular expression evaluated against the raw byte string. */
  regex: RegExp;
  /**
   * Upper bound, in bytes, on the length of any match this pattern can
   * produce. An error is thrown if a longer match is ever observed.
   */
  maxLength: number;
}

export interface RawMatch {
  /** Byte offset in the original input, inclusive. */
  start: number;
  /** Byte offset in the original input, exclusive. */
  end: number;
  /** Name of the pattern that produced this match. */
  pattern: string;
  /** True when the match is fully contained in a whitelist range. */
  suppressed: boolean;
}

export interface Finding {
  /** Byte offset in the original input, inclusive. */
  start: number;
  /** Byte offset in the original input, exclusive. */
  end: number;
  /** Names of every pattern whose match contributed to this finding. */
  patterns: string[];
  /** True only when every merged match is fully covered by the whitelist. */
  suppressed: boolean;
}

export type ScanInput = string | Buffer | Uint8Array;

interface CompiledPattern {
  name: string;
  regex: RegExp;
  maxLength: number;
}

function compilePattern(pattern: BytePattern, kind: string): CompiledPattern {
  if (!Number.isInteger(pattern.maxLength) || pattern.maxLength < 1) {
    throw new Error(
      `${kind} pattern "${pattern.name}": maxLength must be a positive integer`,
    );
  }
  // Recompile as a global, non-sticky regex so exec() can walk the window.
  const flags = pattern.regex.flags.replace(/[gy]/g, "") + "g";
  return {
    name: pattern.name,
    regex: new RegExp(pattern.regex.source, flags),
    maxLength: pattern.maxLength,
  };
}

function toBuffer(input: ScanInput): Buffer {
  if (typeof input === "string") return Buffer.from(input, "utf8");
  return Buffer.from(input);
}

export class SecretScanner {
  readonly #secrets: CompiledPattern[];
  readonly #whitelist: CompiledPattern[];
  readonly #retain: number;

  #pending: Buffer = Buffer.alloc(0);
  /** Global byte offset of #pending[0]. */
  #base = 0;
  /** Per secret pattern: global offset at which matching resumes. */
  #resume: number[];
  /** Active whitelist spans in global offsets, deduplicated by "start:end". */
  #whitelistSpans = new Map<string, [number, number]>();
  #matches: RawMatch[] = [];
  #flushed = false;

  constructor(secrets: BytePattern[], whitelist: BytePattern[] = []) {
    if (secrets.length === 0) {
      throw new Error("SecretScanner: at least one secret pattern is required");
    }
    this.#secrets = secrets.map((p) => compilePattern(p, "secret"));
    this.#whitelist = whitelist.map((p) => compilePattern(p, "whitelist"));
    const maxSecret = Math.max(...this.#secrets.map((p) => p.maxLength));
    const maxWhitelist =
      this.#whitelist.length === 0
        ? 0
        : Math.max(...this.#whitelist.map((p) => p.maxLength));
    this.#retain = maxSecret + maxWhitelist;
    this.#resume = this.#secrets.map(() => 0);
  }

  /**
   * Feed the next chunk. Returns the matches finalized by this chunk, in
   * order of their original byte offsets.
   */
  push(chunk: ScanInput): RawMatch[] {
    if (this.#flushed) {
      throw new Error("SecretScanner: push() called after finish()");
    }
    const piece = toBuffer(chunk);
    const buf =
      this.#pending.length === 0 ? piece : Buffer.concat([this.#pending, piece]);
    const localCut = Math.max(0, buf.length - this.#retain);
    const emitted = this.#scanWindow(buf, localCut);
    this.#pending = buf.subarray(localCut);
    this.#base += localCut;
    // Whitelist spans ending at or before the new base can never contain a
    // future match, so they are safe to drop.
    for (const [key, span] of this.#whitelistSpans) {
      if (span[1] <= this.#base) this.#whitelistSpans.delete(key);
    }
    return emitted;
  }

  /**
   * Flush the retained tail and return all findings with overlapping
   * pattern matches merged. Idempotent.
   */
  finish(): Finding[] {
    if (!this.#flushed) {
      this.#flushed = true;
      this.#scanWindow(this.#pending, this.#pending.length);
      this.#pending = Buffer.alloc(0);
    }
    return mergeFindings(this.#matches);
  }

  /** Every finalized match, in order of original byte offset. */
  get rawMatches(): readonly RawMatch[] {
    return this.#matches;
  }

  /**
   * Scan one window. Matches starting before `localCut` (window-relative)
   * are final: their full possible extent (start + maxLength) lies inside
   * the window, and any whitelist span that could contain them has already
   * been observed. Later matches are left for a future window.
   */
  #scanWindow(buf: Buffer, localCut: number): RawMatch[] {
    const text = buf.toString("latin1");
    const globalCut = this.#base + localCut;

    for (const wp of this.#whitelist) {
      wp.regex.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = wp.regex.exec(text)) !== null) {
        if (m[0].length === 0) {
          wp.regex.lastIndex += 1;
          continue;
        }
        if (m[0].length > wp.maxLength) {
          throw new Error(
            `whitelist pattern "${wp.name}" matched ${m[0].length} byte(s), ` +
              `exceeding its declared maxLength of ${wp.maxLength}`,
          );
        }
        const start = this.#base + m.index;
        const end = start + m[0].length;
        this.#whitelistSpans.set(`${start}:${end}`, [start, end]);
      }
    }

    const emitted: RawMatch[] = [];
    for (let i = 0; i < this.#secrets.length; i++) {
      const sp = this.#secrets[i];
      sp.regex.lastIndex = Math.max(0, this.#resume[i] - this.#base);
      let m: RegExpExecArray | null;
      while ((m = sp.regex.exec(text)) !== null) {
        if (m[0].length === 0) {
          sp.regex.lastIndex += 1;
          continue;
        }
        if (m[0].length > sp.maxLength) {
          throw new Error(
            `secret pattern "${sp.name}" matched ${m[0].length} byte(s), ` +
              `exceeding its declared maxLength of ${sp.maxLength}`,
          );
        }
        const start = this.#base + m.index;
        if (start >= globalCut) break; // not final yet; re-scanned later
        const end = start + m[0].length;
        const match: RawMatch = {
          start,
          end,
          pattern: sp.name,
          suppressed: this.#isSuppressed(start, end),
        };
        emitted.push(match);
        this.#resume[i] = end;
      }
    }
    emitted.sort(
      (a, b) =>
        a.start - b.start || a.end - b.end || a.pattern.localeCompare(b.pattern),
    );
    // Append in sorted order so rawMatches is ordered by original offset
    // and identical for every possible chunking of the same input.
    for (const match of emitted) this.#matches.push(match);
    return emitted;
  }

  /** A match is suppressed only when fully contained in a whitelist span. */
  #isSuppressed(start: number, end: number): boolean {
    for (const [ws, we] of this.#whitelistSpans.values()) {
      if (ws <= start && end <= we) return true;
    }
    return false;
  }
}

/** Merge matches whose ranges overlap into single findings. */
export function mergeFindings(matches: readonly RawMatch[]): Finding[] {
  const sorted = [...matches].sort(
    (a, b) => a.start - b.start || a.end - b.end || a.pattern.localeCompare(b.pattern),
  );
  const findings: Finding[] = [];
  for (const m of sorted) {
    const last = findings[findings.length - 1];
    if (last && m.start < last.end) {
      last.end = Math.max(last.end, m.end);
      if (!last.patterns.includes(m.pattern)) last.patterns.push(m.pattern);
      last.suppressed = last.suppressed && m.suppressed;
    } else {
      findings.push({
        start: m.start,
        end: m.end,
        patterns: [m.pattern],
        suppressed: m.suppressed,
      });
    }
  }
  return findings;
}

/** One-shot scan of a complete input. */
export function scan(
  input: ScanInput,
  secrets: BytePattern[],
  whitelist: BytePattern[] = [],
): Finding[] {
  const scanner = new SecretScanner(secrets, whitelist);
  scanner.push(input);
  return scanner.finish();
}

/**
 * Render a preview of the input with every non-suppressed finding replaced
 * by mask characters. Suppressed (whitelisted) findings stay visible.
 * Offsets are preserved: masking never changes the byte length.
 */
export function maskPreview(
  input: ScanInput,
  findings: readonly Finding[],
  maskChar = "*",
): string {
  if (maskChar.length !== 1 || maskChar.charCodeAt(0) > 0xff) {
    throw new Error("maskPreview: maskChar must be a single latin1 character");
  }
  const out = toBuffer(input);
  const code = maskChar.charCodeAt(0);
  for (const f of findings) {
    if (f.suppressed) continue;
    out.fill(code, f.start, f.end);
  }
  return out.toString("utf8");
}

/** Render a plain-text report of findings with their original offsets. */
export function formatReport(findings: readonly Finding[]): string {
  if (findings.length === 0) return "no secrets found";
  return findings
    .map((f) => {
      const status = f.suppressed ? "suppressed(whitelisted)" : "ACTIVE";
      return `[${f.start}..${f.end}) ${f.patterns.join("+")} ${status}`;
    })
    .join("\n");
}
