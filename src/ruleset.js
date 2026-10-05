'use strict';

const fs = require('fs');
const { RcError } = require('./errors');
const regex = require('./regex');

// Rules file format:
//   # comment
//   name = <regex>      (named rule, referenceable as @name)
//   <regex>             (anonymous rule)
// The language of a rule set is the union of its rules.

function parseRulesText(text) {
  const defs = new Map();
  const anonymous = [];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/);
    if (m) {
      if (defs.has(m[1])) throw new RcError('RULE_PARSE', `duplicate rule name: ${m[1]}`);
      defs.set(m[1], m[2].trim());
    } else {
      anonymous.push(line);
    }
  }
  return { defs, anonymous };
}

function resolveRefs(ast, defs, stack) {
  switch (ast.type) {
    case 'token':
    case 'empty':
      return ast;
    case 'concat':
      return { type: 'concat', parts: ast.parts.map((p) => resolveRefs(p, defs, stack)) };
    case 'alt':
      return { type: 'alt', options: ast.options.map((o) => resolveRefs(o, defs, stack)) };
    case 'star':
    case 'plus':
    case 'opt':
      return { type: ast.type, expr: resolveRefs(ast.expr, defs, stack) };
    case 'ref': {
      if (stack.includes(ast.name)) {
        throw new RcError(
          'RULE_CYCLE_UNSUPPORTED',
          `cyclic rule reference: ${[...stack, ast.name].join(' -> ')}`
        );
      }
      if (!defs.has(ast.name)) {
        throw new RcError('RULE_PARSE', `undefined rule reference: @${ast.name}`);
      }
      const expanded = resolveRefs(regex.parse(defs.get(ast.name)), defs, [...stack, ast.name]);
      return expanded;
    }
    default:
      throw new RcError('RULE_PARSE', `unknown AST node: ${ast.type}`);
  }
}

function loadRulesText(text) {
  const { defs, anonymous } = parseRulesText(text);
  const asts = [];
  for (const line of anonymous) {
    asts.push(resolveRefs(regex.parse(line), defs, []));
  }
  for (const [name, src] of defs) {
    asts.push(resolveRefs(regex.parse(src), defs, [name]));
  }
  if (asts.length === 0) throw new RcError('RULE_PARSE', 'rule set is empty');
  return asts;
}

function loadRulesFile(path) {
  return loadRulesText(fs.readFileSync(path, 'utf8'));
}

module.exports = { parseRulesText, loadRulesText, loadRulesFile };
