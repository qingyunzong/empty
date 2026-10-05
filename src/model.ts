/** Program model: shared integer variables, mutexes, and straight-line threads. */

export type Operand = { kind: 'const'; value: number } | { kind: 'reg'; name: string };

export type CmpOp = '==' | '!=' | '<' | '<=' | '>' | '>=';

export type Instr =
  | { op: 'read'; reg: string; variable: string }          // reg := shared[variable]
  | { op: 'write'; variable: string; value: Operand }      // shared[variable] := value
  | { op: 'lock'; mutex: string }
  | { op: 'unlock'; mutex: string }
  | { op: 'assert'; left: Operand; cmp: CmpOp; right: Operand };

export interface ThreadDef {
  name: string;
  instrs: Instr[];
}

export interface Program {
  vars: Record<string, number>;   // shared integers with initial values
  mutexes: string[];
  threads: ThreadDef[];
}

export const MAX_THREADS = 3;
export const MAX_INSTRS_PER_THREAD = 8;

export function formatInstr(instr: Instr): string {
  switch (instr.op) {
    case 'read': return `read ${instr.reg} ${instr.variable}`;
    case 'write': return `write ${instr.variable} ${formatOperand(instr.value)}`;
    case 'lock': return `lock ${instr.mutex}`;
    case 'unlock': return `unlock ${instr.mutex}`;
    case 'assert': return `assert ${formatOperand(instr.left)} ${instr.cmp} ${formatOperand(instr.right)}`;
  }
}

export function formatOperand(operand: Operand): string {
  return operand.kind === 'const' ? String(operand.value) : operand.name;
}
