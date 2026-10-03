// Testable CLI core: run(argv, io) where io = { stdout, exit }.
import fs from 'node:fs';
import { TradingEngine, TradeError, BRANCHES } from './engine.js';
import { loadState, saveState } from './store.js';

export function run(argv, io = { stdout: (s) => process.stdout.write(s), exit: (c) => process.exit(c) }) {
  const [cmdArg, logDir] = argv;
  const fail = (code, message) => {
    io.stdout(JSON.stringify({ error: { code, message } }) + '\n');
    io.exit(1);
  };

  if (!cmdArg || !logDir) {
    return fail('INVALID_USAGE', 'usage: node cli.js <command.json | -> <logDir>');
  }

  let command;
  try {
    const raw = cmdArg === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(cmdArg, 'utf8');
    command = JSON.parse(raw);
  } catch {
    return fail('INVALID_COMMAND', 'command must be a readable JSON document');
  }
  if (!command || typeof command !== 'object' || typeof command.op !== 'string') {
    return fail('INVALID_COMMAND', 'command must be an object with an "op" field');
  }

  // Optional failure injection for exercising the saga via the CLI:
  // {"op":"cancel","tradeId":"t1","fail":["REFUND_FEE"]}
  const makeHooks = (failList) => {
    const hooks = {};
    if (failList === undefined) return hooks;
    if (!Array.isArray(failList) || failList.some((b) => !BRANCHES.includes(b))) {
      return fail('INVALID_COMMAND', `"fail" must be an array of: ${BRANCHES.join(', ')}`);
    }
    for (const branch of failList) {
      hooks[branch] = () => {
        throw new Error(`injected failure on ${branch}`);
      };
    }
    return hooks;
  };

  const engine = new TradingEngine(loadState(logDir));
  let result;
  try {
    switch (command.op) {
      case 'deposit':
        result = engine.deposit(command.accountId, command.amount);
        break;
      case 'execute':
        result = engine.executeTrade(command);
        break;
      case 'cancel':
        result = engine.cancelTrade(command.tradeId, makeHooks(command.fail));
        break;
      case 'ack':
        result = engine.acknowledge(command.tradeId, command.branch);
        break;
      case 'get':
        result = engine.getTrade(command.tradeId);
        break;
      case 'account':
        result = engine.getAccount(command.accountId);
        break;
      case 'certificate':
        result = engine.certificate(command.tradeId);
        break;
      default:
        return fail('INVALID_COMMAND', `unknown op: ${command.op}`);
    }
  } catch (err) {
    if (err instanceof TradeError) return fail(err.code, err.message);
    throw err;
  }

  saveState(logDir, engine.state, { command });
  io.stdout(JSON.stringify(result) + '\n');
  io.exit(0);
}
