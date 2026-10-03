'use strict';

const { parse, usesComplement, alphabetOf, RegexSyntaxError } = require('./regex');
const {
  toNFA,
  determinize,
  productDFA,
  minimize,
  shortestWitness,
  certHash,
  projectNfa,
} = require('./automata');
const { PackStore } = require('./packstore');

class AuditError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.exitCode = 5;
  }
}

class Engine {
  constructor(storePath) {
    try {
      this.store = new PackStore(storePath);
    } catch (err) {
      if (err.code === 'CRC_FAILED') {
        throw new AuditError(err.message, 'CRC_FAILED');
      }
      throw err;
    }
    this.currentPackName = null;
    for (const record of this.store.records) {
      if (record.type === 'loadPack' || record.type === 'rollback') {
        this.currentPackName = record.name;
      }
    }
    this.filter = null;
  }

  run(cmd) {
    if (typeof cmd !== 'object' || cmd === null || typeof cmd.cmd !== 'string') {
      throw new AuditError('each line must be an object with a "cmd" field', 'BAD_COMMAND');
    }
    switch (cmd.cmd) {
      case 'loadPack': return this._loadPack(cmd);
      case 'setFilter': return this._setFilter(cmd);
      case 'check': return this._check();
      case 'rollback': return this._rollback(cmd);
      default:
        throw new AuditError(`unknown command '${cmd.cmd}'`, 'BAD_COMMAND');
    }
  }

  _loadPack(cmd) {
    try {
      this.store.loadPack(cmd);
    } catch (err) {
      throw new AuditError(err.message, 'BAD_PACK');
    }
    this.currentPackName = cmd.name;
    return { result: 'loaded', name: cmd.name, version: cmd.version };
  }

  _setFilter(cmd) {
    if (typeof cmd.regex !== 'string') {
      throw new AuditError('setFilter requires a "regex" string', 'BAD_FILTER');
    }
    try {
      parse(cmd.regex);
    } catch (err) {
      if (err instanceof RegexSyntaxError) {
        throw new AuditError(err.message, 'BAD_FILTER');
      }
      throw err;
    }
    if (cmd.project !== undefined) {
      if (!Array.isArray(cmd.project) || cmd.project.some((c) => typeof c !== 'string' || c.length !== 1)) {
        throw new AuditError('project must be an array of single characters', 'BAD_FILTER');
      }
    }
    this.filter = { regex: cmd.regex, project: cmd.project || null };
    return { result: 'filterSet' };
  }

  _rollback(cmd) {
    try {
      this.store.rollback(cmd);
    } catch (err) {
      if (err.code === 'UNKNOWN_PACK' || err.code === 'UNKNOWN_VERSION') {
        throw new AuditError(err.message, err.code);
      }
      throw err;
    }
    this.currentPackName = cmd.name;
    return { result: 'rolledBack', name: cmd.name, version: cmd.version };
  }

  _check() {
    if (!this.currentPackName) {
      throw new AuditError('no pack loaded', 'NO_PACK');
    }
    if (!this.filter) {
      throw new AuditError('no filter set', 'NO_FILTER');
    }
    const pack = this.store.currentPack(this.currentPackName);
    if (!pack) {
      throw new AuditError(`unknown pack '${this.currentPackName}'`, 'UNKNOWN_PACK');
    }

    let dangerAst;
    let filterAst;
    try {
      dangerAst = parse(pack.danger);
      filterAst = parse(this.filter.regex);
    } catch (err) {
      throw new AuditError(err.message, 'BAD_REGEX');
    }

    const needsAlphabet = usesComplement(dangerAst) || usesComplement(filterAst);
    if (needsAlphabet && !pack.alphabet) {
      throw new AuditError(
        'complement (~) requires an explicit finite alphabet in the pack',
        'COMPLEMENT_NO_ALPHABET',
      );
    }

    const symbols = new Set(pack.alphabet || []);
    alphabetOf(dangerAst, symbols);
    alphabetOf(filterAst, symbols);
    const alphabet = [...symbols].sort();

    let dangerNfa = toNFA(dangerAst, alphabet);
    if (this.filter.project) {
      dangerNfa = projectNfa(dangerNfa, new Set(this.filter.project));
    }
    const combined = productDFA(
      determinize(dangerNfa, alphabet),
      determinize(toNFA(filterAst, alphabet), alphabet),
      'inter',
    );

    const witness = shortestWitness(combined);
    if (witness !== null) {
      return { result: 'SAT', witness, len: witness.length };
    }
    const min = minimize(combined);
    return {
      result: 'UNSAT',
      certHash: certHash(min),
      states: min.states.length,
      acceptCount: min.accepts.size,
    };
  }
}

module.exports = { Engine, AuditError };
