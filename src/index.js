export { tokenize, LexError } from './lexer.js';
export { parseDsl, ParseError } from './parser.js';
export { typeCheck, DslTypeError } from './types.js';
export { compileProgram, runBytecode, evalPred } from './bytecode.js';
export { parseHistory, buildVersions, HistoryError } from './history.js';
export { buildConstraints, findSerialization, checkVersion, runCheck } from './checker.js';
export { buildReport, verifyReport, VerifyError } from './verify.js';

import { parseDsl } from './parser.js';
import { typeCheck } from './types.js';
import { compileProgram } from './bytecode.js';
import { parseHistory } from './history.js';
import { runCheck } from './checker.js';

// One-shot convenience API.
export function check(rulesSource, historySource, { rulesFile = '<rules>', historyFile = '<history>' } = {}) {
  const program = typeCheck(parseDsl(rulesSource, rulesFile));
  const compiled = compileProgram(program);
  const events = parseHistory(historySource, historyFile);
  return runCheck(events, compiled, historyFile);
}
