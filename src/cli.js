'use strict';

const { QcEngine } = require('./engine');

function runRequest(req) {
  const engine = new QcEngine(req.config);
  engine.loadState(req.state);
  const results = (req.transactions ?? []).map((txn) => engine.applyTransaction(txn));
  return { results };
}

function main(io = {}) {
  const stdin = io.stdin ?? process.stdin;
  const stdout = io.stdout ?? process.stdout;
  const setExitCode = io.setExitCode ?? ((code) => { process.exitCode = code; });
  const emit = (payload, exitCode) => {
    stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    setExitCode(exitCode);
  };
  let input = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk) => {
    input += chunk;
  });
  stdin.on('end', () => {
    let req;
    try {
      req = JSON.parse(input);
    } catch {
      emit({ error: { code: 'E_INVALID', message: 'request body is not valid JSON' } }, 1);
      return;
    }
    try {
      emit(runRequest(req), 0);
    } catch (err) {
      emit({ error: { code: err.code ?? 'E_INVALID', message: err.message } }, 1);
    }
  });
}

if (require.main === module) main();

module.exports = { runRequest, main };
