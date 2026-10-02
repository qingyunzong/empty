import { DiagnosticError } from './errors.js';

// Pratt parser for the rule DSL.
//
//   program    := decl*
//   decl       := "field" IDENT ":" IDENT ";"              (unit: C | A)
//               | "group" IDENT "=" REGEX ";"
//               | "let" IDENT "=" expr ";"                 (global alias)
//               | "rule" IDENT "on" target "{" stmt* "}"
//   target     := "all" | REGEX | IDENT                    (group name or device ID)
//   stmt       := "let" IDENT "=" expr ";" | "alert" IDENT "when" expr ";"
//   expr       := or-expr
//
// Binding powers (Pratt):  or = 1, and = 2, prefix not = 3,
// comparison = 4, postfix "for" = 5 (comparisons only).

const CMP_OPS = new Set(['>', '>=', '<', '<=', '==', '!=']);

export function parse(tokens) {
  let pos = 0;
  const peek = () => tokens[pos];
  const at = (type, value) => {
    const t = tokens[pos];
    return t.type === type && (value === undefined || t.value === value);
  };
  const fail = (msg, tok = peek()) => {
    throw new DiagnosticError(msg, { phase: 'parse', line: tok.line, col: tok.col });
  };
  const next = () => tokens[pos++];
  const expect = (type, value, what) => {
    if (!at(type, value)) fail(`expected ${what ?? (value ?? type)} but found ${describe(peek())}`);
    return next();
  };
  const describe = (t) =>
    t.type === 'EOF' ? 'end of input' : JSON.stringify(t.value ?? t.type);

  // ---- expressions (Pratt) ----
  const LED_BP = { or: 1, and: 2 };
  const CMP_BP = 4;
  const FOR_BP = 5;

  function parseExpr(minBp) {
    const tok = peek();
    let left;
    if (at('KW', 'not')) {
      next();
      const operand = parseExpr(3); // prefix "not" binds tighter than and/or
      left = { kind: 'not', operand, line: tok.line, col: tok.col };
    } else if (at('PUNCT', '(')) {
      next();
      left = parseExpr(0);
      expect('PUNCT', ')', "')'");
    } else if (at('NUMBER')) {
      next();
      left = { kind: 'number', value: tok.value, unit: null, line: tok.line, col: tok.col };
    } else if (at('QUANTITY')) {
      next();
      left = { kind: 'number', value: tok.value, unit: tok.unit, line: tok.line, col: tok.col };
    } else if (at('IDENT')) {
      next();
      left = { kind: 'ident', name: tok.value, line: tok.line, col: tok.col };
    } else {
      fail(`expected an expression but found ${describe(tok)}`);
    }

    for (;;) {
      const t = peek();
      if (t.type === 'KW' && (t.value === 'or' || t.value === 'and')) {
        const bp = LED_BP[t.value];
        if (bp < minBp) break;
        next();
        const right = parseExpr(bp + 1);
        left = { kind: 'logic', op: t.value, left, right, line: t.line, col: t.col };
        continue;
      }
      if (t.type === 'OP' && CMP_OPS.has(t.value)) {
        if (CMP_BP < minBp) break;
        next();
        // Right operand binds tighter than postfix "for" so that
        // `temp > 80C for 5m` attaches the duration to the comparison.
        const right = parseExpr(FOR_BP + 1);
        if (left.kind === 'compare') {
          fail('chained comparisons are not allowed', t);
        }
        left = { kind: 'compare', op: t.value, left, right, line: t.line, col: t.col };
        continue;
      }
      if (t.type === 'KW' && t.value === 'for') {
        if (FOR_BP < minBp) break;
        if (left.kind !== 'compare') {
          fail('"for" duration may only follow a comparison (e.g. temp > 80C for 5m)', t);
        }
        next();
        const dur = expect('DURATION', undefined, 'a duration such as 5m');
        left = { kind: 'hold', duration: dur.value, operand: left, line: t.line, col: t.col };
        continue;
      }
      break;
    }
    return left;
  }

  // ---- declarations & statements ----
  function parseLet() {
    const kw = expect('KW', 'let');
    const name = expect('IDENT', undefined, 'an alias name');
    expect('PUNCT', '=', "'='");
    const expr = parseExpr(0);
    expect('PUNCT', ';', "';'");
    return { kind: 'let', name: name.value, expr, line: kw.line, col: kw.col };
  }

  function parseTarget() {
    if (at('KW', 'all')) { next(); return { kind: 'all' }; }
    if (at('REGEX')) { const t = next(); return { kind: 'regex', pattern: t.value, line: t.line, col: t.col }; }
    if (at('IDENT')) { const t = next(); return { kind: 'name', name: t.value, line: t.line, col: t.col }; }
    fail('expected a rule target: "all", a device group name, a device ID or /regex/');
  }

  function parseRule() {
    const kw = expect('KW', 'rule');
    const name = expect('IDENT', undefined, 'a rule name');
    expect('KW', 'on', '"on"');
    const target = parseTarget();
    expect('PUNCT', '{', "'{'");
    const body = [];
    while (!at('PUNCT', '}')) {
      if (at('EOF')) fail('unterminated rule body');
      if (at('KW', 'let')) { body.push(parseLet()); continue; }
      if (at('KW', 'alert')) {
        const aw = next();
        const level = expect('IDENT', undefined, 'an alert level (info, warning or critical)');
        expect('KW', 'when', '"when"');
        const expr = parseExpr(0);
        expect('PUNCT', ';', "';'");
        body.push({
          kind: 'alert', level: level.value, levelLine: level.line, levelCol: level.col,
          expr, line: aw.line, col: aw.col,
        });
        continue;
      }
      fail(`expected "let" or "alert" inside a rule body but found ${describe(peek())}`);
    }
    expect('PUNCT', '}');
    return { kind: 'rule', name: name.value, target, body, line: kw.line, col: kw.col };
  }

  const decls = [];
  while (!at('EOF')) {
    if (at('KW', 'field')) {
      next();
      const name = expect('IDENT', undefined, 'a field name');
      expect('PUNCT', ':', "':'");
      const unit = expect('IDENT', undefined, 'a unit (C or A)');
      expect('PUNCT', ';', "';'");
      decls.push({
        kind: 'field', name: name.value, unit: unit.value,
        unitLine: unit.line, unitCol: unit.col, line: name.line, col: name.col,
      });
    } else if (at('KW', 'group')) {
      const kw = next();
      const name = expect('IDENT', undefined, 'a group name');
      expect('PUNCT', '=', "'='");
      const re = expect('REGEX', undefined, 'a /regex/ device group');
      expect('PUNCT', ';', "';'");
      decls.push({ kind: 'group', name: name.value, pattern: re.value, line: kw.line, col: kw.col });
    } else if (at('KW', 'let')) {
      decls.push(parseLet());
    } else if (at('KW', 'rule')) {
      decls.push(parseRule());
    } else {
      fail(`expected "field", "group", "let" or "rule" but found ${describe(peek())}`);
    }
  }
  return { kind: 'program', decls };
}
