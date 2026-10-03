import { scopePath } from './checker.js';

// Compiles one checked version into a flat rule table with stack-machine bytecode.
export function compileVersion(checked) {
  const regexes = [];
  const rules = [];

  const addRegex = (source) => {
    regexes.push(source);
    return regexes.length - 1;
  };

  function gen(node) {
    switch (node.kind) {
      case 'const':
        if (node.ctype === 'regex') return [{ op: 're', idx: addRegex(node.value) }];
        return [{ op: 'const', value: node.value }];
      case 'regex':
        return [{ op: 're', idx: addRegex(node.source) }];
      case 'str':
      case 'boollit':
        return [{ op: 'const', value: node.value }];
      case 'field':
        return [{ op: 'field', name: node.name }];
      case 'not':
        return [...gen(node.e), { op: 'not' }];
      case 'bin':
        if (node.op === 'and' || node.op === 'or') {
          return [...gen(node.l), ...gen(node.r), { op: node.op }];
        }
        return [...gen(node.l), ...gen(node.r), { op: 'cmp', cmp: node.op }];
      case 'in': {
        const op = { cidr: 'in_cidr', range: 'in_range', regex: 'in_regex' }[node.inKind];
        return [...gen(node.l), ...gen(node.r), { op }];
      }
      default:
        throw new Error(`cannot compile node kind ${node.kind}`);
    }
  }

  function walk(scope, matchers) {
    for (const rule of scope.rules) {
      rules.push({
        id: rule.id,
        path: scopePath(scope),
        decision: rule.decision,
        matchers,
        code: gen(rule.expr),
      });
    }
    for (const child of scope.children) {
      const m =
        child.kind === 'global'
          ? matchers
          : [...matchers, { kind: child.kind, value: child.arg }];
      walk(child, m);
    }
  }

  walk(checked.root, []);
  return {
    version: checked.id,
    since: checked.sinceMs,
    rules,
    regexes,
    overrides: checked.overrides,
  };
}
