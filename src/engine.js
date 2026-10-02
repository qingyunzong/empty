'use strict';

const { RuleLibrary, RuleLibError, RegexSyntaxError } = require('./rulelib');

// Error carrying a position inside rules.jsonl; reported on stderr with
// exit code 2 by the CLI.
class CliError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'CliError';
    this.line = line; // 1-based line in rules.jsonl
    this.col = col === undefined ? null : col; // 1-based column, when known
  }
}

function applyEntry(entry, lineNo, lib) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new CliError('each line must be a JSON object', lineNo);
  }
  switch (entry.op) {
    case 'add': {
      const rules = Array.isArray(entry.rules) ? entry.rules : [entry];
      if (rules.length === 0) throw new CliError("'rules' must not be empty", lineNo);
      const ops = rules.map((r) => {
        if (typeof r.id !== 'string' || r.id === '') {
          throw new CliError("add: missing or invalid 'id'", lineNo);
        }
        if (r.kind !== 'red' && r.kind !== 'yellow') {
          throw new CliError(`add '${r.id}': kind must be 'red' or 'yellow'`, lineNo);
        }
        if (typeof r.pattern !== 'string') {
          throw new CliError(`add '${r.id}': missing or invalid 'pattern'`, lineNo);
        }
        return { type: 'add', id: r.id, kind: r.kind, pattern: r.pattern };
      });
      commitLayer(ops, lineNo, lib);
      break;
    }
    case 'del': {
      const ids = Array.isArray(entry.ids) ? entry.ids : [entry.id];
      if (ids.length === 0 || ids.some((id) => typeof id !== 'string' || id === '')) {
        throw new CliError("del: missing or invalid 'id'/'ids'", lineNo);
      }
      commitLayer(ids.map((id) => ({ type: 'del', id })), lineNo, lib);
      break;
    }
    case 'undo':
    case 'redo': {
      const k = entry.k === undefined ? 1 : entry.k;
      if (!Number.isInteger(k) || k < 1) {
        throw new CliError(`${entry.op}: 'k' must be a positive integer`, lineNo);
      }
      try {
        if (entry.op === 'undo') lib.undo(k);
        else lib.redo(k);
      } catch (e) {
        if (e instanceof RuleLibError) throw new CliError(e.message, lineNo);
        throw e;
      }
      break;
    }
    default:
      throw new CliError(`unknown op '${entry.op}'`, lineNo);
  }
}

function commitLayer(ops, lineNo, lib) {
  try {
    lib.applyLayer(ops);
  } catch (e) {
    if (e instanceof RegexSyntaxError) {
      throw new CliError(`regex syntax error: ${e.message}`, lineNo, e.pos + 1);
    }
    if (e instanceof RuleLibError) {
      throw new CliError(e.message, lineNo);
    }
    throw e;
  }
}

// Runs a rules.jsonl log against a (possibly reused) library.
function runRulesLog(text, lib) {
  const library = lib || new RuleLibrary();
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    if (!raw.trim()) return;
    const lineNo = idx + 1;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch (e) {
      throw new CliError(`invalid JSON: ${e.message}`, lineNo);
    }
    applyEntry(entry, lineNo, library);
  });
  return library;
}

module.exports = { CliError, runRulesLog };
