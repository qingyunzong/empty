export type TagName = "p" | "b" | "i" | "br";

const SUPPORTED_TAGS: ReadonlySet<string> = new Set(["p", "b", "i", "br"]);
const VOID_TAGS: ReadonlySet<string> = new Set(["br"]);

export interface EntityRef {
  /** Absolute offset of the leading '&' in the original input. */
  start: number;
  /** Absolute offset just past the trailing ';' in the original input. */
  end: number;
  /** The decoded replacement text. */
  decoded: string;
}

export interface OpenEvent {
  type: "open";
  tag: TagName;
  /** Absolute offset of '<'. */
  start: number;
  /** Absolute offset just past '>'. */
  end: number;
}

export interface CloseEvent {
  type: "close";
  tag: TagName;
  /** Absolute offset of the open tag that is being closed. */
  start: number;
  /** Absolute offset just past the close tag, or null when implicit. */
  end: number | null;
  /** True when closed implicitly (new <p>, mismatched close, or EOF). */
  implicit: boolean;
}

export interface TextEvent {
  type: "text";
  /** Decoded text content. */
  text: string;
  /** Absolute offset of the first raw source character. */
  start: number;
  /** Absolute offset just past the last raw source character. */
  end: number;
  /** Raw source ranges of every decoded entity, in order. */
  entities: EntityRef[];
}

export type DiagnosticCode =
  | "unsupported-tag"
  | "unmatched-close"
  | "unterminated-tag";

export interface Diagnostic {
  /** Absolute offset in the original input. */
  offset: number;
  code: DiagnosticCode;
  message: string;
}

export interface DiagnosticEvent extends Diagnostic {
  type: "diagnostic";
}

export type ParserEvent = OpenEvent | CloseEvent | TextEvent | DiagnosticEvent;

const TAG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9]*/;

interface OpenFrame {
  tag: TagName;
  start: number;
}

/**
 * Incremental parser for the preview markup subset (p, b, i, br and text).
 *
 * Feed input with {@link feed} in arbitrarily sized chunks and finish with
 * {@link end}. The emitted event stream (and therefore the tree and the
 * diagnostic order derived from it) is identical no matter how the input is
 * split into chunks.
 */
export class Parser {
  private buffer = "";
  /** Absolute offset of buffer[0] in the original input. */
  private base = 0;
  private stack: OpenFrame[] = [];
  private events: ParserEvent[] = [];
  private finalized = false;

  feed(chunk: string): void {
    if (this.finalized) throw new Error("cannot feed() after end()");
    this.buffer += chunk;
    this.scan(false);
  }

  end(): ParserEvent[] {
    if (this.finalized) throw new Error("end() called twice");
    this.finalized = true;
    this.scan(true);
    while (this.stack.length > 0) {
      const open = this.stack.pop() as OpenFrame;
      this.emit({ type: "close", tag: open.tag, start: open.start, end: null, implicit: true });
    }
    return this.events;
  }

  private emit(event: ParserEvent): void {
    this.events.push(event);
  }

  private diag(offset: number, code: DiagnosticCode, message: string): void {
    this.emit({ type: "diagnostic", offset, code, message });
  }

  private consume(count: number): void {
    this.buffer = this.buffer.slice(count);
    this.base += count;
  }

  private scan(final: boolean): void {
    for (;;) {
      const lt = this.buffer.indexOf("<");
      if (lt === -1) {
        // No tag start in sight. Hold the text unless this is the final
        // chunk: an entity may still be split across a chunk boundary.
        if (final && this.buffer.length > 0) {
          this.emitText(0, this.buffer.length);
          this.consume(this.buffer.length);
        }
        return;
      }
      if (lt > 0) {
        this.emitText(0, lt);
        this.consume(lt);
        continue;
      }
      // buffer starts with '<'
      if (this.buffer.length < 2) {
        if (final) {
          this.diag(this.base, "unterminated-tag", `unterminated tag at offset ${this.base}`);
          this.emitText(0, 1);
          this.consume(1);
        }
        return;
      }
      const next = this.buffer[1] as string;
      if (next === "/") {
        if (!this.parseCloseTag(final)) return;
        continue;
      }
      if (/[a-zA-Z]/.test(next)) {
        if (!this.parseOpenTag(final)) return;
        continue;
      }
      // '<' followed by something that cannot start a tag: literal text.
      this.emitText(0, 1);
      this.consume(1);
    }
  }

  /** Returns false when more input is needed. */
  private parseOpenTag(final: boolean): boolean {
    const gt = this.buffer.indexOf(">");
    if (gt === -1) {
      if (final) {
        this.diag(this.base, "unterminated-tag", `unterminated tag at offset ${this.base}`);
        this.emitText(0, 1);
        this.consume(1);
        return true;
      }
      return false;
    }
    const nameMatch = TAG_NAME_RE.exec(this.buffer.slice(1));
    const name = (nameMatch as RegExpExecArray)[0].toLowerCase();
    const selfClosing = this.buffer[gt - 1] === "/";
    const tagStart = this.base;
    const tagEnd = this.base + gt + 1;
    this.consume(gt + 1);

    if (!SUPPORTED_TAGS.has(name)) {
      this.diag(tagStart, "unsupported-tag", `unsupported tag <${name}> ignored`);
      return true;
    }
    const tag = name as TagName;
    // A new <p> implicitly closes an open <p> (and anything inside it).
    if (tag === "p") this.closeOpenP();

    if (VOID_TAGS.has(tag) || selfClosing) {
      this.emit({ type: "open", tag, start: tagStart, end: tagEnd });
      this.emit({ type: "close", tag, start: tagStart, end: tagEnd, implicit: false });
      return true;
    }
    this.stack.push({ tag, start: tagStart });
    this.emit({ type: "open", tag, start: tagStart, end: tagEnd });
    return true;
  }

  /** Returns false when more input is needed. */
  private parseCloseTag(final: boolean): boolean {
    const gt = this.buffer.indexOf(">");
    if (gt === -1) {
      if (final) {
        this.diag(this.base, "unterminated-tag", `unterminated tag at offset ${this.base}`);
        this.emitText(0, 2);
        this.consume(2);
        return true;
      }
      return false;
    }
    const inner = this.buffer.slice(2, gt);
    const nameMatch = TAG_NAME_RE.exec(inner);
    const tagStart = this.base;
    const tagEnd = this.base + gt + 1;
    this.consume(gt + 1);

    if (!nameMatch) {
      this.diag(tagStart, "unmatched-close", "malformed closing tag ignored");
      return true;
    }
    const name = nameMatch[0].toLowerCase();
    let idx = -1;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if ((this.stack[i] as OpenFrame).tag === name) {
        idx = i;
        break;
      }
    }
    if (idx === -1) {
      // Closing a tag that is not open: ignore and report.
      this.diag(tagStart, "unmatched-close", `closing tag </${name}> has no matching open tag`);
      return true;
    }
    // Elements left open inside the closed one are closed implicitly.
    while (this.stack.length > idx + 1) {
      const open = this.stack.pop() as OpenFrame;
      this.emit({ type: "close", tag: open.tag, start: open.start, end: null, implicit: true });
    }
    const open = this.stack.pop() as OpenFrame;
    this.emit({ type: "close", tag: open.tag, start: tagStart, end: tagEnd, implicit: false });
    return true;
  }

  private closeOpenP(): void {
    for (let i = this.stack.length - 1; i >= 0; i--) {
      if ((this.stack[i] as OpenFrame).tag === "p") {
        while (this.stack.length > i) {
          const open = this.stack.pop() as OpenFrame;
          this.emit({ type: "close", tag: open.tag, start: open.start, end: null, implicit: true });
        }
        return;
      }
    }
  }

  private emitText(startIdx: number, endIdx: number): void {
    const raw = this.buffer.slice(startIdx, endIdx);
    if (raw.length === 0) return;
    const absStart = this.base + startIdx;
    const { text, entities } = decodeEntities(raw, absStart);
    this.emit({ type: "text", text, start: absStart, end: absStart + raw.length, entities });
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

const MAX_ENTITY_LENGTH = 10; // characters between '&' and ';'

/**
 * Decodes entities in a raw text run. `absStart` is the absolute offset of
 * raw[0] in the original input, used to keep the byte mapping of every
 * decoded entity.
 */
export function decodeEntities(
  raw: string,
  absStart: number,
): { text: string; entities: EntityRef[] } {
  const entities: EntityRef[] = [];
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const amp = raw.indexOf("&", i);
    if (amp === -1) {
      out += raw.slice(i);
      break;
    }
    out += raw.slice(i, amp);
    const semi = raw.indexOf(";", amp + 1);
    if (semi === -1 || semi - amp > MAX_ENTITY_LENGTH) {
      out += "&";
      i = amp + 1;
      continue;
    }
    const decoded = decodeEntityBody(raw.slice(amp + 1, semi));
    if (decoded === null) {
      out += "&";
      i = amp + 1;
      continue;
    }
    entities.push({ start: absStart + amp, end: absStart + semi + 1, decoded });
    out += decoded;
    i = semi + 1;
  }
  return { text: out, entities };
}

function decodeEntityBody(body: string): string | null {
  if (body.startsWith("#")) {
    let code: number;
    if (body[1] === "x" || body[1] === "X") {
      if (!/^[0-9a-fA-F]+$/.test(body.slice(2))) return null;
      code = parseInt(body.slice(2), 16);
    } else {
      if (!/^[0-9]+$/.test(body.slice(1))) return null;
      code = parseInt(body.slice(1), 10);
    }
    if (code > 0x10ffff) return null;
    try {
      return String.fromCodePoint(code);
    } catch {
      return null;
    }
  }
  return NAMED_ENTITIES[body] ?? null;
}
