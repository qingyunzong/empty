'use strict';

const { parse, hasComplement, alphabetOf } = require('./regex');
const { compile, ComplementAlphabetError } = require('./compile');
const dfa = require('./dfa');
const pack = require('./pack');

class AuditError extends Error {
  constructor(code, message, exitCode = 5) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function andAst(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { type: 'intersect', left: a, right: b };
}

class Engine {
  constructor() {
    this.packState = null; // { path, versions, current }
    this.sessionFilter = null; // { regex, alphabet }
  }

  currentRules() {
    if (!this.packState) {
      throw new AuditError('UNKNOWN_PACK', 'no pack loaded; run loadPack first');
    }
    return this.packState.versions[this.packState.current - 1].rules;
  }

  exec(cmd) {
    switch (cmd.op) {
      case 'loadPack': return this.loadPack(cmd);
      case 'appendPack': return this.appendPack(cmd);
      case 'setFilter': return this.setFilter(cmd);
      case 'check': return this.check(cmd);
      case 'rollback': return this.rollback(cmd);
      default:
        throw new AuditError('BAD_COMMAND', `unknown op: ${cmd.op}`, 4);
    }
  }

  loadPack(cmd) {
    const loaded = pack.loadPack(cmd.path);
    this.packState = { path: cmd.path, ...loaded };
    return [`PACK${JSON.stringify({
      path: cmd.path,
      versions: loaded.versions.length,
      current: loaded.current,
      truncated: loaded.truncated,
    })}`];
  }

  appendPack(cmd) {
    if (!Array.isArray(cmd.rules)) {
      throw new AuditError('BAD_COMMAND', 'appendPack requires rules: [...]', 4);
    }
    const version = pack.appendPack(cmd.path, cmd.rules);
    if (this.packState && this.packState.path === cmd.path) {
      const loaded = pack.loadPack(cmd.path);
      this.packState = { path: cmd.path, ...loaded };
    }
    return [`APPENDED${JSON.stringify({ path: cmd.path, version })}`];
  }

  setFilter(cmd) {
    if (cmd.regex === undefined || cmd.regex === null) {
      this.sessionFilter = null;
      return ['FILTERnull'];
    }
    parse(cmd.regex); // validate eagerly
    this.sessionFilter = { regex: cmd.regex, alphabet: cmd.alphabet || null };
    return [`FILTER${JSON.stringify({ regex: cmd.regex, alphabet: cmd.alphabet || null })}`];
  }

  rollback(cmd) {
    if (!this.packState) {
      throw new AuditError('UNKNOWN_PACK', 'no pack loaded; run loadPack first');
    }
    const target = cmd.version;
    const max = this.packState.versions.length;
    if (!Number.isInteger(target) || target < 1 || target > max) {
      // State is intentionally left untouched.
      throw new AuditError(
        'UNKNOWN_VERSION',
        `rollback target ${target} does not exist (pack has versions 1..${max})`,
      );
    }
    this.packState.current = target;
    return [`ROLLBACK${JSON.stringify({ version: target })}`];
  }

  check(cmd) {
    let rules;
    if (cmd.pattern !== undefined) {
      rules = [{
        id: cmd.id || 'adhoc',
        pattern: cmd.pattern,
        filter: cmd.filter,
        alphabet: cmd.alphabet,
      }];
    } else {
      rules = this.currentRules();
    }
    return rules.map((rule) => `${rule.id} ${this.checkRule(rule, cmd)}`);
  }

  checkRule(rule, cmd) {
    const explicitAlphabet = cmd.alphabet || rule.alphabet
      || (this.sessionFilter && this.sessionFilter.alphabet) || null;

    let ast = parse(rule.pattern);
    if (rule.filter) ast = andAst(parse(rule.filter), ast);
    if (this.sessionFilter) ast = andAst(parse(this.sessionFilter.regex), ast);

    const explicit = explicitAlphabet !== null;
    if (hasComplement(ast) && !explicit) {
      throw new AuditError(
        'COMPLEMENT_NO_ALPHABET',
        'complement (~) used but no explicit alphabet was provided',
      );
    }
    const alphabet = explicit
      ? explicitAlphabet
      : [...alphabetOf(ast)].sort();

    let compiled;
    try {
      compiled = compile(ast, alphabet, explicit);
    } catch (e) {
      if (e instanceof ComplementAlphabetError) {
        throw new AuditError('COMPLEMENT_NO_ALPHABET', e.message);
      }
      throw e;
    }
    const min = dfa.minimize(compiled);
    const witness = dfa.shortestWitness(min);
    if (witness !== null) {
      return `SAT${JSON.stringify({ witness, len: witness.length })}`;
    }
    // Emptiness certificate: minimized DFA with zero accepting states.
    return `UNSAT${JSON.stringify({
      certHash: dfa.certHash(min),
      states: min.accept.length,
    })}`;
  }
}

module.exports = { Engine, AuditError };
