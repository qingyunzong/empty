/**
 * Public, finite table of control sequences understood by the session parser.
 *
 * Only sequences listed here have a defined effect on the visible-text model.
 * Any other escape/control sequence (e.g. SGR colors, OSC hyperlinks, DEC
 * private modes) is consumed from the byte stream and silently discarded, so
 * it never leaks into visible text, echo, or program output.
 */

export type ControlEffect =
  | { type: 'lineFeed' }
  | { type: 'carriageReturn' }
  | { type: 'backspace' }
  | { type: 'tab' }
  | { type: 'bell' }
  | { type: 'cursorBack'; count: number }
  | { type: 'cursorForward'; count: number }
  | { type: 'cursorColumn'; column: number }
  | { type: 'eraseInLine'; mode: 0 | 1 | 2 }
  | { type: 'eraseInDisplay'; mode: 0 | 1 | 2 | 3 }
  | { type: 'deleteChars'; count: number }
  | { type: 'insertChars'; count: number };

export interface C0SequenceDef {
  kind: 'c0';
  name: string;
  byte: number;
  effect: ControlEffect;
}

export interface CsiSequenceDef {
  kind: 'csi';
  name: string;
  /** Final byte of the CSI sequence, e.g. 'D' for ESC [ n D. */
  finalByte: string;
  effect: (params: number[]) => ControlEffect;
}

export type ControlSequenceDef = C0SequenceDef | CsiSequenceDef;

function param(params: number[], index: number, fallback: number): number {
  const value = params[index];
  return value === undefined || value === 0 ? fallback : value;
}

export const CONTROL_SEQUENCES: readonly ControlSequenceDef[] = [
  // C0 controls
  { kind: 'c0', name: 'LF', byte: 0x0a, effect: { type: 'lineFeed' } },
  { kind: 'c0', name: 'CR', byte: 0x0d, effect: { type: 'carriageReturn' } },
  { kind: 'c0', name: 'BS', byte: 0x08, effect: { type: 'backspace' } },
  { kind: 'c0', name: 'TAB', byte: 0x09, effect: { type: 'tab' } },
  { kind: 'c0', name: 'BEL', byte: 0x07, effect: { type: 'bell' } },
  // CSI sequences (ESC [ params finalByte)
  {
    kind: 'csi',
    name: 'CUF cursor forward',
    finalByte: 'C',
    effect: (p) => ({ type: 'cursorForward', count: param(p, 0, 1) }),
  },
  {
    kind: 'csi',
    name: 'CUB cursor back',
    finalByte: 'D',
    effect: (p) => ({ type: 'cursorBack', count: param(p, 0, 1) }),
  },
  {
    kind: 'csi',
    name: 'CHA cursor column (1-based)',
    finalByte: 'G',
    effect: (p) => ({ type: 'cursorColumn', column: param(p, 0, 1) - 1 }),
  },
  {
    // Row component is ignored: the model tracks a single growing scrollback
    // of lines, not a fixed screen. Only the column is applied.
    kind: 'csi',
    name: 'CUP cursor position (column only)',
    finalByte: 'H',
    effect: (p) => ({ type: 'cursorColumn', column: param(p, 1, 1) - 1 }),
  },
  {
    kind: 'csi',
    name: 'ED erase in display',
    finalByte: 'J',
    effect: (p) => ({ type: 'eraseInDisplay', mode: param(p, 0, 0) as 0 | 1 | 2 | 3 }),
  },
  {
    kind: 'csi',
    name: 'EL erase in line',
    finalByte: 'K',
    effect: (p) => ({ type: 'eraseInLine', mode: param(p, 0, 0) as 0 | 1 | 2 }),
  },
  {
    kind: 'csi',
    name: 'DCH delete characters',
    finalByte: 'P',
    effect: (p) => ({ type: 'deleteChars', count: param(p, 0, 1) }),
  },
  {
    kind: 'csi',
    name: 'ICH insert characters',
    finalByte: '@',
    effect: (p) => ({ type: 'insertChars', count: param(p, 0, 1) }),
  },
];

const c0ByByte = new Map<number, ControlEffect>();
const csiByFinalByte = new Map<string, (params: number[]) => ControlEffect>();
for (const def of CONTROL_SEQUENCES) {
  if (def.kind === 'c0') c0ByByte.set(def.byte, def.effect);
  else csiByFinalByte.set(def.finalByte, def.effect);
}

/** Effect of a C0 control byte, or null when the byte is not in the table. */
export function c0Effect(byte: number): ControlEffect | null {
  return c0ByByte.get(byte) ?? null;
}

/**
 * Effect of a CSI sequence, or null when its final byte is not in the table
 * (the sequence is then consumed and ignored).
 */
export function csiEffect(finalByte: string, params: number[]): ControlEffect | null {
  const make = csiByFinalByte.get(finalByte);
  return make ? make(params) : null;
}
