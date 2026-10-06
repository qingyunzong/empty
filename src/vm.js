import { VMError } from './errors.js';
import { DECISIONS } from './compiler.js';
import { LEVEL_ORDER } from './checker.js';

const LEVEL_NAMES = ['none', 'minor', 'major', 'critical'];

function tagOf(type) {
  return { quantity: 'q', ratio: 'r', defect_level: 'l', boolean: 'b' }[type];
}

export function inputValue(type, raw) {
  const tag = tagOf(type);
  if (tag === 'l') {
    if (typeof raw === 'string' && raw in LEVEL_ORDER) return { t: 'l', v: LEVEL_ORDER[raw] };
    if (typeof raw === 'number' && raw >= 0 && raw <= 3) return { t: 'l', v: raw };
    throw new VMError(`invalid defect_level input: ${JSON.stringify(raw)}`);
  }
  if (tag === 'b') {
    if (typeof raw === 'boolean') return { t: 'b', v: raw };
    throw new VMError(`invalid boolean input: ${JSON.stringify(raw)}`);
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new VMError(`invalid ${type} input: ${JSON.stringify(raw)}`);
  }
  return { t: tag, v: raw };
}

function expect(val, tags, op) {
  if (!val || !tags.includes(val.t)) {
    throw new VMError(`type error in ${op}: expected ${tags.join('|')}, got ${val ? val.t : 'undefined'}`);
  }
}

const BUILTINS = {
  floor: (a) => ({ t: 'q', v: Math.floor(a.v) }),
  ceil: (a) => ({ t: 'q', v: Math.ceil(a.v) }),
  abs: (a) => ({ t: 'q', v: Math.abs(a.v) }),
  min: (a, b) => ({ t: 'q', v: Math.min(a.v, b.v) }),
  max: (a, b) => ({ t: 'q', v: Math.max(a.v, b.v) }),
};

// Executes a compiled program against inputs { paramName: rawValue }.
// Returns 'ACCEPT' | 'REJECT' | 'CONTINUE'. CONTINUE is a legitimate
// pending outcome, not an error and not "unsatisfiable".
export function run(program, inputs) {
  if (program.format !== 'qcert-bc/1') throw new VMError(`unsupported program format '${program.format}'`);
  const env = new Array(program.slots).fill(null);
  for (const p of program.params) {
    if (!(p.name in inputs)) throw new VMError(`missing input parameter '${p.name}'`);
    env[p.slot] = inputValue(p.type, inputs[p.name]);
  }
  const stack = [];
  let ip = 0;
  const code = program.code;
  const bin = (op, fn, tags) => {
    const r = stack.pop();
    const l = stack.pop();
    expect(l, tags, op); expect(r, tags, op);
    stack.push(fn(l, r));
  };
  const num = (op, fn) => bin(op, (l, r) => {
    if (l.t !== r.t && !(l.t !== 'b' && r.t !== 'b')) throw new VMError(`type error in ${op}`);
    return fn(l, r);
  }, ['q', 'r']);

  for (;;) {
    if (ip >= code.length) throw new VMError('program ended without a decision');
    const instr = code[ip++];
    const [op, a, b] = instr;
    switch (op) {
      case 'PUSH': stack.push({ ...program.constants[a] }); break;
      case 'LOAD': {
        const v = env[a];
        if (!v) throw new VMError(`read of uninitialised slot ${a}`);
        stack.push(v);
        break;
      }
      case 'STORE': env[a] = stack.pop(); break;
      case 'ADD': num('ADD', (l, r) => ({ t: l.t, v: l.v + r.v })); break;
      case 'SUB': num('SUB', (l, r) => ({ t: l.t, v: l.v - r.v })); break;
      case 'MUL': {
        const r = stack.pop(); const l = stack.pop();
        expect(l, ['q', 'r'], 'MUL'); expect(r, ['q', 'r'], 'MUL');
        const t = l.t === 'r' && r.t === 'r' ? 'r' : 'q';
        stack.push({ t, v: l.v * r.v });
        break;
      }
      case 'DIV': {
        const r = stack.pop(); const l = stack.pop();
        expect(l, ['q', 'r'], 'DIV'); expect(r, ['q', 'r'], 'DIV');
        if (r.v === 0) throw new VMError('division by zero');
        const t = l.t === 'q' && r.t === 'q' ? 'r' : (l.t === 'q' ? 'q' : 'r');
        stack.push({ t, v: l.v / r.v });
        break;
      }
      case 'NEG': {
        const v = stack.pop(); expect(v, ['q', 'r'], 'NEG');
        stack.push({ t: v.t, v: -v.v });
        break;
      }
      case 'LT': bin('LT', (l, r) => ({ t: 'b', v: l.v < r.v }), ['q', 'r', 'l']); break;
      case 'LE': bin('LE', (l, r) => ({ t: 'b', v: l.v <= r.v }), ['q', 'r', 'l']); break;
      case 'GT': bin('GT', (l, r) => ({ t: 'b', v: l.v > r.v }), ['q', 'r', 'l']); break;
      case 'GE': bin('GE', (l, r) => ({ t: 'b', v: l.v >= r.v }), ['q', 'r', 'l']); break;
      case 'EQ': bin('EQ', (l, r) => ({ t: 'b', v: l.v === r.v }), ['q', 'r', 'l', 'b']); break;
      case 'NE': bin('NE', (l, r) => ({ t: 'b', v: l.v !== r.v }), ['q', 'r', 'l', 'b']); break;
      case 'AND': bin('AND', (l, r) => ({ t: 'b', v: l.v && r.v }), ['b']); break;
      case 'OR': bin('OR', (l, r) => ({ t: 'b', v: l.v || r.v }), ['b']); break;
      case 'NOT': {
        const v = stack.pop(); expect(v, ['b'], 'NOT');
        stack.push({ t: 'b', v: !v.v });
        break;
      }
      case 'CALL': {
        const fn = BUILTINS[a];
        if (!fn) throw new VMError(`unknown builtin '${a}'`);
        const args = stack.splice(stack.length - b, b);
        for (const arg of args) expect(arg, ['q', 'r'], a);
        stack.push(fn(...args));
        break;
      }
      case 'JIF': {
        const v = stack.pop(); expect(v, ['b'], 'JIF');
        if (!v.v) ip = a;
        break;
      }
      case 'JMP': ip = a; break;
      case 'EMIT': return DECISIONS[a];
      default: throw new VMError(`unknown opcode '${op}'`);
    }
  }
}

export { LEVEL_NAMES };
