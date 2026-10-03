import { LedgerNetwork, LedgerError } from './ledger.js';

export function createSession(network = new LedgerNetwork()) {
  const dispatch = (command) => {
    switch (command?.op) {
      case 'add-edge':
        return network.addEdge(command.from, command.to);
      case 'remove-edge':
        return network.removeEdge(command.from, command.to);
      case 'correct-direction':
        return network.correctDirection(command.from, command.to);
      case 'snapshot':
        return network.snapshot();
      case 'rollback':
        return network.rollback(command.snapshot);
      case 'query':
        return network.query();
      default:
        throw new LedgerError('unknown-op', `unknown operation: ${JSON.stringify(command?.op)}`);
    }
  };

  return {
    network,
    handleLine(line) {
      const trimmed = String(line).trim();
      if (!trimmed) return null;
      try {
        return dispatch(JSON.parse(trimmed));
      } catch (error) {
        if (error instanceof LedgerError) {
          return { error: error.code, message: error.message };
        }
        return { error: 'invalid-command', message: String(error?.message ?? error) };
      }
    },
  };
}
