import { CONTROL_SEQUENCES, INCOMPLETE_CSI } from "./control-sequences.js";
import type { ControlSequenceSpec } from "./control-sequences.js";
import { Screen } from "./screen.js";

export type SegmentKind = "echo" | "output" | "control";

export interface Segment {
  readonly kind: SegmentKind;
  /** Decoded text, or the raw sequence for control segments. */
  readonly text: string;
  /** Byte offset into the received stream, inclusive. */
  readonly start: number;
  /** Byte offset into the received stream, exclusive. */
  readonly end: number;
  /** False when the stream ended in the middle of an escape sequence. */
  readonly complete: boolean;
  /** Control segments only: name from CONTROL_SEQUENCES, "UNKNOWN" or "INCOMPLETE". */
  readonly name?: string;
  /** Control segments only: whether the sequence is in the public table. */
  readonly known?: boolean;
}

export interface SentCommand {
  readonly text: string;
  /** Byte offset into the sent stream, inclusive. */
  readonly start: number;
  /** Byte offset into the sent stream, exclusive. */
  readonly end: number;
  /** False when the command has no line terminator (truncated command). */
  readonly complete: boolean;
}

interface EscapeMatch {
  readonly length: number;
  readonly spec: ControlSequenceSpec | null;
  readonly groups: readonly string[];
}

const ESC = 0x1b;

const singleByteSpecs = new Map<number, ControlSequenceSpec>();
const escapeSpecs: ControlSequenceSpec[] = [];
const controlFirstBytes = new Set<number>();
for (const spec of CONTROL_SEQUENCES) {
  controlFirstBytes.add(spec.firstByte);
  if (spec.firstByte === ESC) escapeSpecs.push(spec);
  else singleByteSpecs.set(spec.firstByte, spec);
}

function latin1(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("latin1");
}

function utf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}

/** Length of a trailing incomplete UTF-8 sequence, or 0 if none. */
function incompleteUtf8Tail(bytes: Uint8Array, end: number): number {
  let i = end - 1;
  const floor = Math.max(0, end - 4);
  while (i >= floor) {
    const byte = bytes[i]!;
    if ((byte & 0x80) === 0) return 0;
    if ((byte & 0xc0) === 0xc0) {
      const need =
        (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1;
      return end - i < need ? end - i : 0;
    }
    i -= 1;
  }
  return 0;
}

function isParamByte(code: number): boolean {
  return code >= 0x30 && code <= 0x3f;
}

function isIntermediateByte(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isFinalByte(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Match an escape sequence at the start of `s` (s[0] is ESC).
 * Returns null when more bytes are needed to decide.
 */
function matchEscape(s: string): EscapeMatch | null {
  for (const spec of escapeSpecs) {
    const m = spec.pattern.exec(s);
    if (m !== null) return { length: m[0].length, spec, groups: m.slice(1) };
  }
  if (INCOMPLETE_CSI.test(s)) return null;
  if (s.length < 2) return null;
  if (s[1] !== "[") return { length: 2, spec: null, groups: [] };
  let i = 2;
  while (i < s.length && isParamByte(s.charCodeAt(i))) i += 1;
  while (i < s.length && isIntermediateByte(s.charCodeAt(i))) i += 1;
  if (i >= s.length) return null;
  if (isFinalByte(s.charCodeAt(i))) return { length: i + 1, spec: null, groups: [] };
  return { length: Math.max(i, 2), spec: null, groups: [] };
}

function param(groups: readonly string[], index: number, fallback: number): number {
  const raw = groups[index];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isNaN(value) ? fallback : value;
}

/**
 * Streaming parser for a command session.
 *
 * - send() records bytes sent to the terminal (commands). A command without
 *   a trailing CR/LF is recorded with complete=false (truncated).
 * - write() feeds bytes received from the terminal in arbitrary chunks.
 *   Received text matching pending sent bytes is classified as echo; all
 *   other text is program output. Echo is never reported as output.
 * - end() flushes; a trailing partial escape sequence becomes a control
 *   segment with complete=false.
 *
 * Feeding the same bytes in any chunking yields identical segments
 * (kind, text, original offsets) and identical visible text.
 */
export class SessionParser {
  readonly segments: Segment[] = [];
  readonly commands: SentCommand[] = [];

  private readonly screen = new Screen();
  private pending: Buffer = Buffer.from("");
  private recvOffset = 0;
  private sentOffset = 0;
  private sentChunks: Buffer[] = [];
  private echoQueue = "";
  private ended = false;

  /** Record bytes sent to the terminal. Returns the recorded command. */
  send(data: string | Uint8Array): SentCommand {
    const text = typeof data === "string" ? data : utf8(data);
    const bytes = Buffer.from(text, "utf8");
    this.sentChunks.push(bytes);
    const command: SentCommand = {
      text,
      start: this.sentOffset,
      end: this.sentOffset + bytes.length,
      complete: /[\r\n]$/.test(text),
    };
    this.sentOffset = command.end;
    this.commands.push(command);
    this.echoQueue += text.replace(/[\r\n]+$/u, "");
    return command;
  }

  /** Feed a chunk of bytes received from the terminal. */
  write(chunk: string | Uint8Array): void {
    if (this.ended) throw new Error("write() after end()");
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
    this.pending = this.pending.length === 0 ? bytes : Buffer.concat([this.pending, bytes]);
    this.drain(false);
  }

  /** Flush the stream. Leftover partial escape bytes become an incomplete segment. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.drain(true);
  }

  /** Visible screen text after applying echo, output and control effects. */
  visibleText(): string {
    return this.screen.text();
  }

  /** Program output only (echo and control sequences excluded). */
  outputText(): string {
    return this.segments.filter((s) => s.kind === "output").map((s) => s.text).join("");
  }

  /** Terminal echo of sent bytes (never part of the program result). */
  echoText(): string {
    return this.segments.filter((s) => s.kind === "echo").map((s) => s.text).join("");
  }

  /** All bytes ever sent, concatenated. */
  sentText(): string {
    return Buffer.concat(this.sentChunks).toString("utf8");
  }

  private drain(flush: boolean): void {
    for (;;) {
      if (this.pending.length === 0) return;
      const first = this.pending[0]!;
      if (controlFirstBytes.has(first)) {
        if (first === ESC) {
          const match = matchEscape(latin1(this.pending));
          if (match === null) {
            if (flush) this.emitIncompleteControl();
            return;
          }
          this.emitControl(match);
          continue;
        }
        this.emitControl({ length: 1, spec: singleByteSpecs.get(first)!, groups: [] });
        continue;
      }
      let runEnd = 0;
      while (runEnd < this.pending.length && !controlFirstBytes.has(this.pending[runEnd]!)) {
        runEnd += 1;
      }
      // Hold back a trailing incomplete UTF-8 sequence only when the buffer
      // itself ended; a following control byte proves the character ended.
      const tail = runEnd === this.pending.length ? incompleteUtf8Tail(this.pending, runEnd) : 0;
      const complete = runEnd - tail;
      if (complete === 0) {
        if (flush) {
          this.emitTextRun(this.pending.subarray(0, runEnd));
          this.advance(runEnd);
        }
        return;
      }
      this.emitTextRun(this.pending.subarray(0, complete));
      this.advance(complete);
    }
  }

  private advance(count: number): void {
    this.pending = this.pending.subarray(count);
    this.recvOffset += count;
  }

  private classify(ch: string): "echo" | "output" {
    if (this.echoQueue.length > 0) {
      if (this.echoQueue.startsWith(ch)) {
        this.echoQueue = this.echoQueue.slice(ch.length);
        return "echo";
      }
      // Mismatch: the terminal is not echoing (the rest of) this command.
      this.echoQueue = "";
    }
    return "output";
  }

  private emitTextRun(bytes: Uint8Array): void {
    const text = utf8(bytes);
    let offset = this.recvOffset;
    let kind: "echo" | "output" | null = null;
    let start = offset;
    let current = "";
    const flushSegment = (): void => {
      if (kind === null) return;
      this.pushTextSegment(kind, current, start, offset);
    };
    for (const ch of text) {
      const chKind = this.classify(ch);
      if (chKind !== kind) {
        flushSegment();
        kind = chKind;
        start = offset;
        current = "";
      }
      current += ch;
      this.screen.writeChar(ch);
      offset += Buffer.byteLength(ch, "utf8");
    }
    flushSegment();
  }

  /**
   * Append a text segment, merging with the previous one when it is adjacent
   * and of the same kind. This keeps the segment stream identical no matter
   * how the input bytes were chunked.
   */
  private pushTextSegment(kind: "echo" | "output", text: string, start: number, end: number): void {
    const last = this.segments[this.segments.length - 1];
    if (last !== undefined && last.kind === kind && last.complete && last.end === start) {
      this.segments[this.segments.length - 1] = { ...last, text: last.text + text, end };
      return;
    }
    this.segments.push({ kind, text, start, end, complete: true });
  }

  private emitControl(match: EscapeMatch): void {
    const raw = latin1(this.pending.subarray(0, match.length));
    this.segments.push({
      kind: "control",
      text: raw,
      start: this.recvOffset,
      end: this.recvOffset + match.length,
      complete: true,
      name: match.spec === null ? "UNKNOWN" : match.spec.name,
      known: match.spec !== null,
    });
    if (match.spec !== null) this.applyEffect(match.spec, match.groups);
    this.advance(match.length);
  }

  private emitIncompleteControl(): void {
    const raw = latin1(this.pending);
    this.segments.push({
      kind: "control",
      text: raw,
      start: this.recvOffset,
      end: this.recvOffset + this.pending.length,
      complete: false,
      name: "INCOMPLETE",
      known: false,
    });
    this.advance(this.pending.length);
  }

  private applyEffect(spec: ControlSequenceSpec, groups: readonly string[]): void {
    switch (spec.effect) {
      case "ignore":
        break;
      case "backspace":
        this.screen.backspace();
        break;
      case "carriageReturn":
        this.screen.carriageReturn();
        break;
      case "lineFeed":
        this.screen.lineFeed();
        break;
      case "cursorUp":
        this.screen.moveCursor(-param(groups, 0, 1), 0);
        break;
      case "cursorDown":
        this.screen.moveCursor(param(groups, 0, 1), 0);
        break;
      case "cursorForward":
        this.screen.moveCursor(0, param(groups, 0, 1));
        break;
      case "cursorBack":
        this.screen.moveCursor(0, -param(groups, 0, 1));
        break;
      case "cursorPosition":
        this.screen.setCursor(param(groups, 1, 1), param(groups, 0, 1));
        break;
      case "eraseInLine":
        this.screen.eraseInLine(param(groups, 0, 0));
        break;
      case "eraseInDisplay":
        this.screen.eraseInDisplay(param(groups, 0, 0));
        break;
    }
  }
}
