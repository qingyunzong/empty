/**
 * JSON masking by JSON Pointer (RFC 6901) with duplicate-key rejection.
 *
 * Guarantees:
 *  - Decoded object keys are checked for duplicates within their object
 *    BEFORE any masked output is produced. `{"a":1,"\u0061":2}` is rejected
 *    because both keys decode to "a". This ensures a signature verifier and
 *    a display layer can never read different same-name members.
 *  - Non-target bytes of a valid document are preserved exactly: whitespace,
 *    key order, string escape forms and number lexemes (`1e2`, `0.500`, `-0`)
 *    pass through untouched. Masking splices replacement text into the
 *    original input; it never re-serializes.
 *  - Input may be fed in arbitrary chunks; escapes may span chunk boundaries.
 */

import { JsonSyntaxError, Scanner, Token } from './scanner';

export { JsonSyntaxError } from './scanner';

export class DuplicateKeyError extends Error {
  readonly pointer: string;
  readonly key: string;
  constructor(pointer: string, key: string) {
    super(`duplicate decoded key ${JSON.stringify(key)} in object at ${pointer === '' ? '(root)' : JSON.stringify(pointer)}`);
    this.name = 'DuplicateKeyError';
    this.pointer = pointer;
    this.key = key;
  }
}

export class InvalidPointerError extends Error {
  constructor(pointer: string) {
    super(`invalid JSON Pointer ${JSON.stringify(pointer)}`);
    this.name = 'InvalidPointerError';
  }
}

export interface MaskOptions {
  /** JSON Pointers (RFC 6901) selecting values to mask. '' selects the root. */
  readonly pointers: readonly string[];
  /** Raw JSON text spliced in place of each masked value. Default: `"***"`. */
  readonly replacement?: string;
}

const POINTER_RE = /^(?:\/(?:[^/~]|~[01])*)*$/;

function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

interface Frame {
  readonly kind: 'object' | 'array';
  readonly pointer: string;
  /** Decoded keys seen so far (objects only). */
  readonly keys: Set<string>;
  /** Next element index (arrays only). */
  index: number;
  /** Decoded key of the member whose value is expected (objects only). */
  pendingKey: string;
  state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'valueOrEnd' | 'commaOrEnd';
  /** Raw offset where this container opened, if it is itself a mask target. */
  recordStart: number | null;
  /** Whether this frame is inside (or is) a masked region. */
  counted: boolean;
}

export class JsonMasker {
  private readonly scanner = new Scanner();
  private readonly targets: ReadonlySet<string>;
  private readonly replacement: string;
  private readonly spans: Array<readonly [number, number]> = [];
  private readonly stack: Frame[] = [];
  private maskedDepth = 0;
  private rootStarted = false;
  private rootDone = false;

  constructor(options: MaskOptions) {
    for (const pointer of options.pointers) {
      if (!POINTER_RE.test(pointer)) {
        throw new InvalidPointerError(pointer);
      }
    }
    this.targets = new Set(options.pointers);
    this.replacement = options.replacement ?? '"***"';
    try {
      JSON.parse(this.replacement);
    } catch {
      throw new JsonSyntaxError('replacement is not valid JSON', 0);
    }
  }

  /** Feed a chunk of JSON text. Escapes may span chunk boundaries. */
  feed(chunk: string): void {
    for (const token of this.scanner.feed(chunk)) {
      this.consume(token);
    }
  }

  /**
   * Finish and return the masked document.
   * Throws DuplicateKeyError before any output if any object contains two
   * keys that decode to the same string, and JsonSyntaxError on invalid JSON.
   */
  end(): string {
    for (const token of this.scanner.end()) {
      this.consume(token);
    }
    if (this.stack.length > 0) {
      throw new JsonSyntaxError('unexpected end of input', this.scanner.getText().length);
    }
    if (!this.rootDone) {
      throw new JsonSyntaxError('empty input', 0);
    }
    return this.splice();
  }

  private consume(token: Token): void {
    if (this.rootDone) {
      throw new JsonSyntaxError('unexpected content after root value', token.start);
    }
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      this.rootStarted = true;
      this.handleValue(token, '');
      return;
    }
    switch (top.state) {
      case 'keyOrEnd':
        if (token.type === 'punct' && token.value === '}') {
          this.closeFrame(token);
        } else if (token.type === 'string') {
          this.acceptKey(top, token);
        } else {
          throw new JsonSyntaxError('expected object key or }', token.start);
        }
        break;
      case 'key':
        if (token.type === 'string') {
          this.acceptKey(top, token);
        } else {
          throw new JsonSyntaxError('expected object key', token.start);
        }
        break;
      case 'colon':
        if (token.type === 'punct' && token.value === ':') {
          top.state = 'value';
        } else {
          throw new JsonSyntaxError('expected :', token.start);
        }
        break;
      case 'value':
        this.handleValue(token, this.childPointer(top));
        top.state = 'commaOrEnd';
        break;
      case 'valueOrEnd':
        if (token.type === 'punct' && token.value === ']') {
          this.closeFrame(token);
        } else {
          this.handleValue(token, this.childPointer(top));
          top.state = 'commaOrEnd';
        }
        break;
      case 'commaOrEnd': {
        const closer = top.kind === 'object' ? '}' : ']';
        if (token.type === 'punct' && token.value === ',') {
          top.state = top.kind === 'object' ? 'key' : 'value';
        } else if (token.type === 'punct' && token.value === closer) {
          this.closeFrame(token);
        } else {
          throw new JsonSyntaxError(`expected , or ${closer}`, token.start);
        }
        break;
      }
    }
  }

  private acceptKey(frame: Frame, token: Extract<Token, { type: 'string' }>): void {
    const key = token.decoded;
    if (frame.keys.has(key)) {
      throw new DuplicateKeyError(frame.pointer, key);
    }
    frame.keys.add(key);
    frame.pendingKey = key;
    frame.state = 'colon';
  }

  private childPointer(frame: Frame): string {
    const segment = frame.kind === 'object' ? frame.pendingKey : String(frame.index);
    return frame.pointer + '/' + escapeSegment(segment);
  }

  private handleValue(token: Token, pointer: string): void {
    const parent = this.stack[this.stack.length - 1];
    if (parent !== undefined && parent.kind === 'array') {
      parent.index++;
    }
    if (token.type === 'punct' && (token.value === '{' || token.value === '[')) {
      const insideMasked = this.maskedDepth > 0;
      const matched = this.targets.has(pointer);
      this.stack.push({
        kind: token.value === '{' ? 'object' : 'array',
        pointer,
        keys: new Set<string>(),
        index: 0,
        pendingKey: '',
        state: token.value === '{' ? 'keyOrEnd' : 'valueOrEnd',
        recordStart: !insideMasked && matched ? token.start : null,
        counted: insideMasked || matched,
      });
      if (insideMasked || matched) {
        this.maskedDepth++;
      }
      return;
    }
    if (token.type === 'punct') {
      throw new JsonSyntaxError(`unexpected ${token.value}`, token.start);
    }
    if (this.maskedDepth === 0 && this.targets.has(pointer)) {
      this.spans.push([token.start, token.end]);
    }
    if (this.stack.length === 0) {
      this.rootDone = true;
    }
  }

  private closeFrame(token: Token): void {
    const frame = this.stack.pop() as Frame;
    if (frame.recordStart !== null) {
      this.spans.push([frame.recordStart, token.end]);
    }
    if (frame.counted) {
      this.maskedDepth--;
    }
    if (this.stack.length === 0) {
      this.rootDone = true;
    }
  }

  private splice(): string {
    const text = this.scanner.getText();
    const spans = [...this.spans].sort((a, b) => a[0] - b[0]);
    let out = '';
    let cursor = 0;
    for (const [start, end] of spans) {
      out += text.slice(cursor, start) + this.replacement;
      cursor = end;
    }
    return out + text.slice(cursor);
  }
}

/** One-shot helper: mask `input` according to `options`. */
export function maskJson(input: string, options: MaskOptions): string {
  const masker = new JsonMasker(options);
  masker.feed(input);
  return masker.end();
}
