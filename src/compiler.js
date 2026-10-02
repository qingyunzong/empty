import { lex } from './lexer.js';

const CMP_OPS = ['==', '!=', '>', '>=', '<', '<='];
const ARITH_OPS = { add: 'ADD', sub: 'SUB', mul: 'MUL', div: 'DIV' };

function compileStatement(tokens, line, ctx) {
  const head = tokens[0];
  if (!head || head.type !== 'IDENT') {
    throw new SyntaxError(`Expected a statement keyword at line ${line}`);
  }
  const fail = (msg) => {
    throw new SyntaxError(`${msg} at line ${line}`);
  };
  const need = (n) => {
    if (tokens.length < n) fail(`Malformed '${head.value}' statement`);
  };
  const fieldOf = (t) => {
    if (!t || t.type !== 'IDENT') fail(`Expected a field name`);
    return t.value;
  };
  const operandOf = (t) => {
    if (!t) fail('Expected an operand');
    if (t.type === 'NUMBER' || t.type === 'STRING') return { const: t.value };
    if (t.type === 'IDENT') return { field: t.value };
    fail(`Unexpected operand '${t.value}'`);
    return null;
  };
  const literalOf = (t) => {
    if (!t || (t.type !== 'NUMBER' && t.type !== 'STRING')) {
      fail('Expected a literal value');
    }
    return t.value;
  };
  const numberOf = (t) => {
    if (!t || t.type !== 'NUMBER') fail('Expected a numeric literal');
    return t.value;
  };
  const cmpOf = (t) => {
    if (!t || t.type !== 'SYMBOL' || !CMP_OPS.includes(t.value)) {
      fail(`Expected a comparison operator (${CMP_OPS.join(' ')})`);
    }
    return t.value;
  };
  const symbolOf = (t, value) => {
    if (!t || t.type !== 'SYMBOL' || t.value !== value) fail(`Expected '${value}'`);
  };
  const keywordOf = (t, value) => {
    if (!t || t.type !== 'IDENT' || t.value !== value) fail(`Expected '${value}'`);
  };

  const word = head.value;
  if (word === 'set') {
    need(3);
    ctx.instrs.push({ op: 'SET', field: fieldOf(tokens[1]), value: literalOf(tokens[2]) });
  } else if (word in ARITH_OPS) {
    need(4);
    ctx.instrs.push({
      op: ARITH_OPS[word],
      field: fieldOf(tokens[1]),
      a: operandOf(tokens[2]),
      b: operandOf(tokens[3]),
    });
  } else if (word === 'clamp') {
    need(4);
    ctx.instrs.push({
      op: 'CLAMP',
      field: fieldOf(tokens[1]),
      lo: numberOf(tokens[2]),
      hi: numberOf(tokens[3]),
    });
  } else if (word === 'filter') {
    need(4);
    ctx.instrs.push({
      op: 'FILTER',
      field: fieldOf(tokens[1]),
      cmp: cmpOf(tokens[2]),
      value: operandOf(tokens[3]),
    });
  } else if (word === 'if') {
    need(6);
    ctx.instrs.push({
      op: 'CMP',
      field: fieldOf(tokens[1]),
      cmp: cmpOf(tokens[2]),
      value: operandOf(tokens[3]),
    });
    keywordOf(tokens[4], 'goto');
    const index = ctx.instrs.length;
    ctx.instrs.push({ op: 'JIF', target: null });
    ctx.fixups.push({ index, label: fieldOf(tokens[5]), line });
  } else if (word === 'goto' || word === 'jmp') {
    need(2);
    const index = ctx.instrs.length;
    ctx.instrs.push({ op: 'JMP', target: null });
    ctx.fixups.push({ index, label: fieldOf(tokens[1]), line });
  } else if (word === 'label') {
    need(2);
    const name = fieldOf(tokens[1]);
    if (name in ctx.labels) fail(`Duplicate label '${name}'`);
    ctx.labels[name] = ctx.instrs.length;
  } else if (word === 'map') {
    need(7);
    const field = fieldOf(tokens[1]);
    symbolOf(tokens[2], '=');
    const table = fieldOf(tokens[3]);
    symbolOf(tokens[4], '[');
    const keyField = fieldOf(tokens[5]);
    symbolOf(tokens[6], ']');
    ctx.instrs.push({ op: 'MAP', field, table, keyField });
  } else {
    fail(`Unknown statement '${word}'`);
  }
}

// Compiles a correction script into { instrs, tables }. `instrs` is the
// bytecode array (SET/ADD/SUB/MUL/DIV/CLAMP/FILTER/CMP/JIF/JMP/MAP/HALT);
// `tables` holds the key->value maps built from #!table CSV blocks.
export function compile(source) {
  const lines = lex(source);
  const ctx = { instrs: [], labels: {}, fixups: [] };
  const tables = {};
  let currentTable = null;

  for (const line of lines) {
    if (line.kind === 'directive') {
      if (line.name === 'table') {
        currentTable = line.args[0];
        if (!currentTable) {
          throw new SyntaxError(`#!table requires a name at line ${line.line}`);
        }
        if (tables[currentTable]) {
          throw new SyntaxError(`Duplicate table '${currentTable}' at line ${line.line}`);
        }
        tables[currentTable] = {};
      } else {
        currentTable = null;
      }
      continue;
    }
    if (line.kind === 'csv') {
      if (!currentTable) {
        throw new SyntaxError(`CSV row outside of a #!table block at line ${line.line}`);
      }
      const [key, ...rest] = line.cells;
      tables[currentTable][String(key)] = rest.length === 1 ? rest[0] : rest;
      continue;
    }
    compileStatement(line.tokens, line.line, ctx);
  }

  for (const fixup of ctx.fixups) {
    if (!(fixup.label in ctx.labels)) {
      throw new SyntaxError(`Unknown label '${fixup.label}' at line ${fixup.line}`);
    }
    ctx.instrs[fixup.index].target = ctx.labels[fixup.label];
  }
  for (const ins of ctx.instrs) {
    if (ins.op === 'MAP' && !(ins.table in tables)) {
      throw new SyntaxError(`Unknown table '${ins.table}' referenced by map`);
    }
  }
  ctx.instrs.push({ op: 'HALT' });
  return { instrs: ctx.instrs, tables };
}
