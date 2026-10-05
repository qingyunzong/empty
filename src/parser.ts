/** Line-based parser for the input language, with the required limit checks. */
import { CmpOp, Instr, MAX_INSTRS_PER_THREAD, MAX_THREADS, Operand, Program, ThreadDef } from './model';

export class ParseError extends Error {
  constructor(public line: number, message: string) {
    super(`line ${line}: ${message}`);
    this.name = 'ParseError';
  }
}

const CMP_OPS: CmpOp[] = ['==', '!=', '<=', '>=', '<', '>'];

function parseOperand(token: string, line: number): Operand {
  if (/^-?\d+$/.test(token)) return { kind: 'const', value: parseInt(token, 10) };
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return { kind: 'reg', name: token };
  throw new ParseError(line, `invalid operand '${token}' (expected integer literal or register)`);
}

/**
 * Grammar (one directive per line, '#' starts a comment):
 *   var <name> = <int>        declare shared integer
 *   mutex <name>              declare mutex
 *   thread <name> ... end     thread body (<= 8 instructions, <= 3 threads)
 * Instructions: read <reg> <var> | write <var> <int|reg> |
 *               lock <mutex> | unlock <mutex> |
 *               assert <int|reg> <cmp> <int|reg>
 */
export function parseProgram(source: string): Program {
  const vars: Record<string, number> = {};
  const mutexes: string[] = [];
  const threads: ThreadDef[] = [];
  let current: ThreadDef | null = null;
  const definedRegs = new Set<string>();

  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const text = lines[i].replace(/#.*/, '').trim();
    if (text === '') continue;
    const tokens = text.split(/\s+/);
    const head = tokens[0];

    if (current === null) {
      if (head === 'var') {
        const m = text.match(/^var\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(-?\d+)$/);
        if (!m) throw new ParseError(lineNo, `malformed var declaration (expected 'var <name> = <int>')`);
        if (m[1] in vars) throw new ParseError(lineNo, `duplicate variable '${m[1]}'`);
        vars[m[1]] = parseInt(m[2], 10);
      } else if (head === 'mutex') {
        if (tokens.length !== 2) throw new ParseError(lineNo, `malformed mutex declaration`);
        if (mutexes.includes(tokens[1])) throw new ParseError(lineNo, `duplicate mutex '${tokens[1]}'`);
        mutexes.push(tokens[1]);
      } else if (head === 'thread') {
        if (tokens.length !== 2) throw new ParseError(lineNo, `malformed thread declaration`);
        if (threads.some(t => t.name === tokens[1])) throw new ParseError(lineNo, `duplicate thread '${tokens[1]}'`);
        current = { name: tokens[1], instrs: [] };
        definedRegs.clear();
      } else {
        throw new ParseError(lineNo, `expected 'var', 'mutex' or 'thread', got '${head}'`);
      }
      continue;
    }

    // Inside a thread body.
    if (head === 'end') {
      threads.push(current);
      current = null;
      continue;
    }

    let instr: Instr;
    if (head === 'read' && tokens.length === 3) {
      const [, reg, variable] = tokens;
      if (!(variable in vars)) throw new ParseError(lineNo, `unknown shared variable '${variable}'`);
      definedRegs.add(reg);
      instr = { op: 'read', reg, variable };
    } else if (head === 'write' && tokens.length === 3) {
      const [, variable, valueTok] = tokens;
      if (!(variable in vars)) throw new ParseError(lineNo, `unknown shared variable '${variable}'`);
      const value = parseOperand(valueTok, lineNo);
      if (value.kind === 'reg' && !definedRegs.has(value.name)) {
        throw new ParseError(lineNo, `register '${value.name}' used before any read into it`);
      }
      instr = { op: 'write', variable, value };
    } else if ((head === 'lock' || head === 'unlock') && tokens.length === 2) {
      if (!mutexes.includes(tokens[1])) throw new ParseError(lineNo, `unknown mutex '${tokens[1]}'`);
      instr = { op: head, mutex: tokens[1] };
    } else if (head === 'assert' && tokens.length === 4) {
      const left = parseOperand(tokens[1], lineNo);
      const cmp = tokens[2] as CmpOp;
      if (!CMP_OPS.includes(cmp)) throw new ParseError(lineNo, `unknown comparison operator '${tokens[2]}'`);
      const right = parseOperand(tokens[3], lineNo);
      for (const o of [left, right]) {
        if (o.kind === 'reg' && !definedRegs.has(o.name)) {
          throw new ParseError(lineNo, `register '${o.name}' used before any read into it`);
        }
      }
      instr = { op: 'assert', left, cmp, right };
    } else {
      throw new ParseError(lineNo, `unrecognized instruction '${text}'`);
    }

    current.instrs.push(instr);
    if (current.instrs.length > MAX_INSTRS_PER_THREAD) {
      throw new ParseError(lineNo, `thread '${current.name}' has more than ${MAX_INSTRS_PER_THREAD} instructions`);
    }
  }

  if (current !== null) throw new ParseError(lines.length, `thread '${current.name}' is missing 'end'`);
  if (threads.length === 0) throw new ParseError(0, 'program must declare at least one thread');
  if (threads.length > MAX_THREADS) {
    throw new ParseError(0, `program has ${threads.length} threads; at most ${MAX_THREADS} are allowed`);
  }
  return { vars, mutexes, threads };
}
