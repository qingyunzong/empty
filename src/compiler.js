// Compiles checked rule ASTs to stack-machine bytecode.
//
// Instruction set (operates on time series, see vm.js):
//   CONST { value }        push a constant series
//   LOAD  { field }        push the value series of a sensor field
//   CMP   { cmp }          pop b, a; push boolean series of (a <cmp> b)
//   AND / OR               pop b, a; push boolean combination
//   NOT                    pop a; push negation
//   HOLD  { ms }           pop boolean series; push series that becomes true
//                          only after the input held true for `ms`

const CMP_NAMES = { '>': 'gt', '<': 'lt', '>=': 'ge', '<=': 'le', '==': 'eq', '!=': 'ne' };

function emit(expr, ops) {
  switch (expr.kind) {
    case 'num':
      ops.push({ op: 'CONST', value: expr.value });
      return;
    case 'ident':
      if (expr.resolved.kind === 'field') ops.push({ op: 'LOAD', field: expr.resolved.field });
      else ops.push({ op: 'CONST', value: expr.resolved.value });
      return;
    case 'cmp':
      emit(expr.left, ops);
      emit(expr.right, ops);
      ops.push({ op: 'CMP', cmp: CMP_NAMES[expr.op] });
      return;
    case 'and':
      emit(expr.left, ops);
      emit(expr.right, ops);
      ops.push({ op: 'AND' });
      return;
    case 'or':
      emit(expr.left, ops);
      emit(expr.right, ops);
      ops.push({ op: 'OR' });
      return;
    case 'not':
      emit(expr.expr, ops);
      ops.push({ op: 'NOT' });
      return;
    case 'for':
      emit(expr.expr, ops);
      ops.push({ op: 'HOLD', ms: expr.ms });
      return;
    default:
      throw new Error(`cannot compile node kind '${expr.kind}'`);
  }
}

export function compileRules(checked) {
  return checked.rules.map((rule) => {
    const ops = [];
    emit(rule.expr, ops);
    return {
      name: rule.name,
      level: rule.level,
      devices: rule.devices,
      program: ops,
    };
  });
}

export function matchesDevice(rule, device) {
  return rule.devices.idents.includes(device) || rule.devices.regexes.some((re) => re.test(device));
}
