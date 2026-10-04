/**
 * The public, finite table of control sequences understood by the parser.
 *
 * Every received byte stream is interpreted exclusively through this table:
 * sequences listed here produce a known `control` segment and apply their
 * declared effect to the visible-text model; anything else that looks like
 * an escape sequence is consumed deterministically as an UNKNOWN control
 * segment with no effect on visible state.
 */

export type ControlEffect =
  | "ignore"
  | "backspace"
  | "carriageReturn"
  | "lineFeed"
  | "cursorUp"
  | "cursorDown"
  | "cursorForward"
  | "cursorBack"
  | "cursorPosition"
  | "eraseInLine"
  | "eraseInDisplay";

export interface ControlSequenceSpec {
  /** Stable public name, e.g. "CSI_ERASE_LINE". */
  readonly name: string;
  /** First byte of the sequence; used by the scanner to leave text mode. */
  readonly firstByte: number;
  /** Anchored regular expression matched against a latin1 view of the bytes. */
  readonly pattern: RegExp;
  /** Effect applied to the visible-text model when the sequence matches. */
  readonly effect: ControlEffect;
}

const ESC = 0x1b;

export const CONTROL_SEQUENCES: readonly ControlSequenceSpec[] = [
  { name: "BEL", firstByte: 0x07, pattern: /^\x07/, effect: "ignore" },
  { name: "BS", firstByte: 0x08, pattern: /^\x08/, effect: "backspace" },
  { name: "LF", firstByte: 0x0a, pattern: /^\x0a/, effect: "lineFeed" },
  { name: "CR", firstByte: 0x0d, pattern: /^\x0d/, effect: "carriageReturn" },
  { name: "CSI_SGR", firstByte: ESC, pattern: /^\x1b\[([0-9;]*)m/, effect: "ignore" },
  { name: "CSI_CURSOR_UP", firstByte: ESC, pattern: /^\x1b\[([0-9]*)A/, effect: "cursorUp" },
  { name: "CSI_CURSOR_DOWN", firstByte: ESC, pattern: /^\x1b\[([0-9]*)B/, effect: "cursorDown" },
  { name: "CSI_CURSOR_FORWARD", firstByte: ESC, pattern: /^\x1b\[([0-9]*)C/, effect: "cursorForward" },
  { name: "CSI_CURSOR_BACK", firstByte: ESC, pattern: /^\x1b\[([0-9]*)D/, effect: "cursorBack" },
  { name: "CSI_CURSOR_POSITION", firstByte: ESC, pattern: /^\x1b\[([0-9]*);([0-9]*)H/, effect: "cursorPosition" },
  { name: "CSI_ERASE_LINE", firstByte: ESC, pattern: /^\x1b\[([0-9]*)K/, effect: "eraseInLine" },
  { name: "CSI_ERASE_DISPLAY", firstByte: ESC, pattern: /^\x1b\[([0-9]*)J/, effect: "eraseInDisplay" },
];

/**
 * Matches a buffer that is a proper prefix of a CSI sequence in the table
 * (params are limited to digits and ';' by the table above). Used to decide
 * whether the parser must wait for more bytes before deciding.
 */
export const INCOMPLETE_CSI = /^\x1b(\[[0-9;]*)?$/;
