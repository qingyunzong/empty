import { JsonSyntaxError } from './errors.js';
import { canonicalPointer, parsePointer } from './json-pointer.js';
import { StreamJsonParser } from './stream-parser.js';

export interface MaskOptions {
  /** RFC 6901 JSON pointers whose values are replaced by the mask. */
  pointers: Iterable<string>;
  /** Replacement JSON text for masked values. Defaults to "\"***\"". */
  mask?: string;
}

const DEFAULT_MASK = '"***"';

/**
 * Streaming desensitizer. Feed input with write() in arbitrarily sized
 * chunks, then call end() to obtain the masked document.
 *
 * The document is fully parsed and validated first: any duplicate decoded
 * object key aborts with DuplicateKeyError before end() returns, so no
 * masked output is ever produced for ambiguous input (where a signature
 * check and a display path could read different same-named members).
 * Legal input is re-emitted byte-for-byte except for the masked spans.
 */
export class JsonMasker {
  private readonly parser: StreamJsonParser;
  private readonly mask: string;

  constructor(options: MaskOptions) {
    const targets = new Set<string>();
    for (const pointer of options.pointers) {
      targets.add(canonicalPointer(parsePointer(pointer)));
    }
    this.mask = options.mask ?? DEFAULT_MASK;
    try {
      JSON.parse(this.mask);
    } catch {
      throw new JsonSyntaxError(
        `Mask must be a valid JSON value, got ${JSON.stringify(this.mask)}`,
        0,
      );
    }
    this.parser = new StreamJsonParser(targets);
  }

  write(chunk: string): this {
    this.parser.write(chunk);
    return this;
  }

  end(): string {
    this.parser.end();
    const input = this.parser.input;
    let output = '';
    let last = 0;
    for (const span of this.parser.maskSpans) {
      output += input.slice(last, span.start);
      output += this.mask;
      last = span.end;
    }
    output += input.slice(last);
    return output;
  }
}

export function maskJson(
  input: string,
  pointers: Iterable<string>,
  mask?: string,
): string {
  const options: MaskOptions = { pointers };
  if (mask !== undefined) {
    options.mask = mask;
  }
  const masker = new JsonMasker(options);
  masker.write(input);
  return masker.end();
}
