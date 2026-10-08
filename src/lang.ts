// Language definition: types, parser, validation, formatting.
//
// Program shape (line based, '#' starts a comment):
//
//   shared x = 0
//   thread t0
//     read r1          # r1 := x
//     write r1 + 1     # x := r1 + 1
//     lock             # blocks until the mutex is free, then takes it
//     unlock           # releases the mutex (error if not held by this thread)
//     assert x >= 1    # fails the execution if the comparison is false
//
// Hard limits (validated by parseProgram): at most 3 threads, at most 8
// instructions per thread. Instructions are only read/write/lock/unlock/assert.

export type Cmp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type Operand =
  | { kind: 'const'; value: number }
  | { kind: 'reg'; reg: number }      // r1..r4, thread local
  | { kind: 'shared' };               // the shared integer x

export interface Expr {
  base: Operand;
  delta: number; // operand + delta
}

export type Instr =
  | { kind: 'read'; reg: number }
  | { kind: 'write'; expr: Expr }
  | { kind: 'lock' }
  | { kind: 'unlock' }
  | { kind: 'assert'; left: Expr; cmp: Cmp; right: Expr };

export interface ThreadDef {
  name: string;
  instrs: Instr[];
}

export interface Program {
  init: number;
  threads: ThreadDef[];
}

export const MAX_THREADS = 3;
export const MAX_INSTRS = 8;

export class ParseError extends Error {}

export function parseProgram(src: string): Program {
  const lines = src.split(/\r?\n/);
  let init: number | null = null;
  const threads: ThreadDef[] = [];
  let current: ThreadDef | null = null;

  lines.forEach((raw, idx) => {
    const lineNo = idx + 1;
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;

    let m: RegExpExecArray | null;
    if ((m = /^shared\s+x\s*=\s*(-?\d+)$/.exec(line))) {
      if (init !== null) throw new ParseError(`line ${lineNo}: duplicate "shared x" declaration`);
      if (current) throw new ParseError(`line ${lineNo}: "shared x" must come before any thread`);
      init = parseInt(m[1], 10);
      return;
    }
    if ((m = /^thread\s+([A-Za-z_]\w*)$/.exec(line))) {
      current = { name: m[1], instrs: [] };
      threads.push(current);
      return;
    }
    if (!current) throw new ParseError(`line ${lineNo}: instruction outside any thread: "${line}"`);
    current.instrs.push(parseInstr(line, lineNo));
  });

  if (init === null) throw new ParseError('missing "shared x = <int>" declaration');
  if (threads.length === 0) throw new ParseError('program declares no threads');
  if (threads.length > MAX_THREADS) {
    throw new ParseError(`too many threads: ${threads.length} (max ${MAX_THREADS})`);
  }
  for (const t of threads) {
    if (t.instrs.length === 0) throw new ParseError(`thread ${t.name} has no instructions`);
    if (t.instrs.length > MAX_INSTRS) {
      throw new ParseError(`thread ${t.name} has ${t.instrs.length} instructions (max ${MAX_INSTRS})`);
    }
  }
  return { init, threads };
}

export function parseInstr(line: string, lineNo: number): Instr {
  let m = /^read\s+(r[1-4])$/.exec(line);
  if (m) return { kind: 'read', reg: parseInt(m[1][1], 10) };
  if (line === 'lock') return { kind: 'lock' };
  if (line === 'unlock') return { kind: 'unlock' };
  if ((m = /^write\s+(.+)$/.exec(line))) {
    return { kind: 'write', expr: parseExpr(m[1], lineNo) };
  }
  if ((m = /^assert\s+(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/.exec(line))) {
    return {
      kind: 'assert',
      left: parseExpr(m[1], lineNo),
      cmp: m[2] as Cmp,
      right: parseExpr(m[3], lineNo),
    };
  }
  throw new ParseError(
    `line ${lineNo}: unknown instruction "${line}" (expected read|write|lock|unlock|assert)`,
  );
}

function parseOperand(tok: string, lineNo: number): Operand {
  if (tok === 'x') return { kind: 'shared' };
  const rm = /^r([1-4])$/.exec(tok);
  if (rm) return { kind: 'reg', reg: parseInt(rm[1], 10) };
  if (/^-?\d+$/.test(tok)) return { kind: 'const', value: parseInt(tok, 10) };
  throw new ParseError(`line ${lineNo}: bad operand "${tok}" (expected integer, x, or r1..r4)`);
}

function parseExpr(text: string, lineNo: number): Expr {
  const m = /^(.+?)\s*([+-])\s*(\d+)$/.exec(text.trim());
  if (m) {
    const base = parseOperand(m[1].trim(), lineNo);
    const delta = (m[2] === '-' ? -1 : 1) * parseInt(m[3], 10);
    return { base, delta };
  }
  return { base: parseOperand(text.trim(), lineNo), delta: 0 };
}

export function formatOperand(o: Operand): string {
  if (o.kind === 'const') return String(o.value);
  if (o.kind === 'reg') return `r${o.reg}`;
  return 'x';
}

export function formatExpr(e: Expr): string {
  const b = formatOperand(e.base);
  if (e.delta === 0) return b;
  return e.delta > 0 ? `${b} + ${e.delta}` : `${b} - ${-e.delta}`;
}

export function formatInstr(i: Instr): string {
  switch (i.kind) {
    case 'read': return `read r${i.reg}`;
    case 'write': return `write ${formatExpr(i.expr)}`;
    case 'lock': return 'lock';
    case 'unlock': return 'unlock';
    case 'assert': return `assert ${formatExpr(i.left)} ${i.cmp} ${formatExpr(i.right)}`;
  }
}
