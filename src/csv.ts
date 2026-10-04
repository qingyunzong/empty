import { Buffer } from "node:buffer";

/** A parsed field, preserving its raw byte range in the original stream. */
export interface FieldInfo {
  /** Index of the record this field belongs to (0-based). */
  recordIndex: number;
  /** Index of the field within its record (0-based). */
  fieldIndex: number;
  /** Absolute byte offset of the field start (inclusive). */
  start: number;
  /** Absolute byte offset of the field end (exclusive). */
  end: number;
  /** Raw source text of the field, quotes included, exactly as input. */
  raw: string;
  /** Decoded value: surrounding quotes removed, "" collapsed to ". */
  value: string;
  /** True when the field opened with a legal quote. */
  quoted: boolean;
  /** True when an illegal quote (or junk after a closing quote) was quarantined. */
  malformed: boolean;
}

/** A parsed record with its raw byte range (line terminator included). */
export interface RecordInfo {
  /** Record index (0-based). */
  index: number;
  /** Absolute byte offset of the record start (inclusive). */
  start: number;
  /** Absolute byte offset of the record end (exclusive, terminator included). */
  end: number;
  fields: FieldInfo[];
}

const COMMA = 0x2c; // ,
const QUOTE = 0x22; // "
const CR = 0x0d; // \r
const LF = 0x0a; // \n

type State =
  | "field-start" // no byte of the current field consumed yet
  | "unquoted" // inside an unquoted field
  | "quoted" // inside a legally quoted field
  | "quote-in-quoted" // just saw " inside a quoted field: closing or escaped
  | "after-quoted-junk"; // junk after the closing quote, quarantined to line end

/**
 * Incremental CSV parser fed with arbitrary byte chunks.
 *
 * Semantics:
 * - A field starting with `"` is quoted: `""` is an escaped quote and
 *   newlines inside legal quotes are data, not record separators.
 * - A `"` anywhere else is illegal. It is quarantined to the end of the
 *   physical line: treated as a literal byte, it can never open a quoted
 *   section, so the next physical newline still terminates the record.
 * - Junk after a closing quote is quarantined the same way.
 * - Records are terminated by `\n`, `\r\n` or a lone `\r`.
 */
export class CsvParser {
  private state: State = "field-start";
  private offset = 0; // absolute offset of the next byte to consume
  private rawBytes: number[] = []; // raw bytes of the current field
  private valueBytes: number[] = []; // decoded bytes of the current field
  private fieldStart = 0;
  private fieldQuoted = false;
  private fieldMalformed = false;
  private fieldOpen = false; // a field of the current record has begun
  private fields: FieldInfo[] = [];
  private recordStart = 0;
  private recordEnd = 0;
  private recordIndex = 0;
  private pendingLF = false; // last record ended on CR; absorb one optional LF
  /** All records completed so far. */
  readonly records: RecordInfo[] = [];

  /** Feed one chunk; returns the records completed by this chunk. */
  feed(chunk: Buffer | Uint8Array | string): RecordInfo[] {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    const emitted: RecordInfo[] = [];
    for (let i = 0; i < buf.length; i++) {
      const byte = buf[i];
      const pos = this.offset++;
      if (this.pendingLF) {
        this.pendingLF = false;
        if (byte === LF) {
          this.recordEnd = pos + 1; // extend the record over the \r\n pair
          this.emitRecord(emitted);
          continue;
        }
        this.emitRecord(emitted); // lone \r terminated the record
      }
      this.consume(byte, pos, emitted);
    }
    return emitted;
  }

  /** Flush any pending field/record at end of input. */
  end(): RecordInfo[] {
    const emitted: RecordInfo[] = [];
    if (this.pendingLF) {
      this.pendingLF = false;
      this.emitRecord(emitted);
    }
    if (this.fieldOpen || this.fields.length > 0) {
      this.endField(this.offset);
      this.recordEnd = this.offset;
      this.emitRecord(emitted);
    }
    return emitted;
  }

  private consume(byte: number, pos: number, out: RecordInfo[]): void {
    if (!this.fieldOpen) {
      this.fieldOpen = true;
      this.fieldStart = pos;
      if (this.fields.length === 0) this.recordStart = pos;
    }
    switch (this.state) {
      case "field-start":
        if (byte === QUOTE) {
          this.fieldQuoted = true;
          this.rawBytes.push(byte);
          this.state = "quoted";
        } else if (byte === COMMA) {
          this.endField(pos);
        } else if (byte === CR) {
          this.endField(pos);
          this.endRecordAtCR(pos);
        } else if (byte === LF) {
          this.endField(pos);
          this.recordEnd = pos + 1;
          this.emitRecord(out);
        } else {
          this.rawBytes.push(byte);
          this.valueBytes.push(byte);
          this.state = "unquoted";
        }
        break;
      case "unquoted":
        if (byte === COMMA) {
          this.endField(pos);
        } else if (byte === CR) {
          this.endField(pos);
          this.endRecordAtCR(pos);
        } else if (byte === LF) {
          this.endField(pos);
          this.recordEnd = pos + 1;
          this.emitRecord(out);
        } else {
          // Illegal quote: quarantined to this physical line — kept as a
          // literal byte, it cannot start a quoted section, so the next
          // newline still ends the record.
          if (byte === QUOTE) this.fieldMalformed = true;
          this.rawBytes.push(byte);
          this.valueBytes.push(byte);
        }
        break;
      case "quoted":
        this.rawBytes.push(byte);
        if (byte === QUOTE) {
          this.state = "quote-in-quoted";
        } else {
          this.valueBytes.push(byte); // newlines inside legal quotes are data
        }
        break;
      case "quote-in-quoted":
        if (byte === QUOTE) {
          this.rawBytes.push(byte);
          this.valueBytes.push(byte); // "" collapses to a single "
          this.state = "quoted";
        } else if (byte === COMMA) {
          this.endField(pos);
        } else if (byte === CR) {
          this.endField(pos);
          this.endRecordAtCR(pos);
        } else if (byte === LF) {
          this.endField(pos);
          this.recordEnd = pos + 1;
          this.emitRecord(out);
        } else {
          // Junk after the closing quote: quarantined to the physical line.
          this.fieldMalformed = true;
          this.rawBytes.push(byte);
          this.valueBytes.push(byte);
          this.state = "after-quoted-junk";
        }
        break;
      case "after-quoted-junk":
        if (byte === COMMA) {
          this.endField(pos);
        } else if (byte === CR) {
          this.endField(pos);
          this.endRecordAtCR(pos);
        } else if (byte === LF) {
          this.endField(pos);
          this.recordEnd = pos + 1;
          this.emitRecord(out);
        } else {
          this.rawBytes.push(byte);
          this.valueBytes.push(byte);
        }
        break;
    }
  }

  private endRecordAtCR(pos: number): void {
    this.recordEnd = pos + 1;
    this.pendingLF = true; // a following LF belongs to this terminator
  }

  private endField(endPos: number): void {
    this.fields.push({
      recordIndex: this.recordIndex,
      fieldIndex: this.fields.length,
      start: this.fieldStart,
      end: endPos,
      raw: Buffer.from(this.rawBytes).toString("utf8"),
      value: Buffer.from(this.valueBytes).toString("utf8"),
      quoted: this.fieldQuoted,
      malformed: this.fieldMalformed,
    });
    this.rawBytes = [];
    this.valueBytes = [];
    this.fieldQuoted = false;
    this.fieldMalformed = false;
    this.state = "field-start";
    this.fieldStart = endPos + 1;
    this.fieldOpen = true;
  }

  private emitRecord(out: RecordInfo[]): void {
    const record: RecordInfo = {
      index: this.recordIndex,
      start: this.recordStart,
      end: this.recordEnd,
      fields: this.fields,
    };
    this.recordIndex++;
    this.fields = [];
    this.fieldOpen = false;
    this.state = "field-start";
    this.records.push(record);
    out.push(record);
  }
}

/** Parse a whole buffer in one shot. */
export function parseCsv(input: Buffer | Uint8Array | string): RecordInfo[] {
  const parser = new CsvParser();
  parser.feed(input);
  parser.end();
  return parser.records;
}
