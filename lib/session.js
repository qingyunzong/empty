/**
 * Session layer shared by the CLI and tests: turns NDJSON command lines
 * into response objects plus an exit code (0 = keep going, 1 = fatal
 * command error). A declined freeze is a normal response, not an error.
 */
import { CreditNetwork, CreditError } from './network.js';

function dispatch(network, command) {
  if (command === null || typeof command !== 'object' || Array.isArray(command)) {
    throw new CreditError('INVALID_COMMAND', 'each line must be a JSON object');
  }
  switch (command.cmd) {
    case 'add-edge':
      return network.addEdge(command.from, command.to, command.capacity);
    case 'set-capacity':
      return network.setCapacity(command.from, command.to, command.capacity);
    case 'freeze':
      return network.freeze(command.source, command.target, command.amount);
    case 'release':
      return network.release(command.freezeId, command.amount);
    default:
      throw new CreditError('UNKNOWN_COMMAND', `unknown cmd: ${String(command.cmd)}`);
  }
}

export class CliSession {
  constructor(network = new CreditNetwork()) {
    this.network = network;
  }

  /**
   * Handle one raw input line. Returns null for blank lines, otherwise
   * { output, exitCode } where exitCode is 1 exactly when a command error
   * occurred (the CLI should print the output and exit with that code).
   */
  handleLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed) return null;
    try {
      return { output: dispatch(this.network, JSON.parse(trimmed)), exitCode: 0 };
    } catch (err) {
      if (err instanceof SyntaxError) {
        return {
          output: { ok: false, code: 'INVALID_COMMAND', error: `invalid JSON: ${err.message}` },
          exitCode: 1,
        };
      }
      return {
        output: { ok: false, code: err.code ?? 'INTERNAL_ERROR', error: err.message },
        exitCode: 1,
      };
    }
  }

  /** Run a whole NDJSON payload; stops at the first fatal command error. */
  run(input) {
    const outputs = [];
    for (const line of String(input).split('\n')) {
      const result = this.handleLine(line);
      if (result === null) continue;
      outputs.push(result.output);
      if (result.exitCode !== 0) return { outputs, exitCode: result.exitCode };
    }
    return { outputs, exitCode: 0 };
  }
}
