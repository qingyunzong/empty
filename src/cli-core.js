import { RefundError, RefundService } from './refund.js';
import { JsonlStore } from './jsonl-store.js';

export const USAGE = `usage: node cli.js [--store <path>] <command> [json-payload]
commands: settle | refund | register | cancel | balance | history
payload may be omitted and read from stdin instead`;

function parseArgs(argv, env) {
  let storePath = env.REFUND_STORE || 'history.jsonl';
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--store') {
      storePath = argv[i + 1];
      i += 1;
    } else {
      rest.push(argv[i]);
    }
  }
  const [command, payloadText] = rest;
  return { storePath, command, payloadText };
}

/**
 * Run one CLI invocation. Returns { code, output } where output is the JSON
 * line that the CLI prints and code is the process exit code (0 or 1).
 */
export async function runCli(argv, { stdinText = '', env = process.env } = {}) {
  try {
    const { storePath, command, payloadText } = parseArgs(argv, env);
    if (!command) {
      throw new RefundError('INVALID_INPUT', USAGE);
    }
    const raw = payloadText !== undefined ? payloadText : stdinText.trim();
    const payload = raw.length > 0 ? JSON.parse(raw) : {};

    const store = new JsonlStore(storePath);
    const service = RefundService.fromEvents(store.load(), {
      appendEvent: (event) => store.append(event),
    });

    let result;
    switch (command) {
      case 'settle':
        result = service.settlePayment(payload);
        break;
      case 'refund':
        result = service.requestRefund(payload);
        break;
      case 'register':
        result = service.registerRefund(payload.refundId ?? payload);
        break;
      case 'cancel':
        result = service.cancelRefund(payload.refundId ?? payload);
        break;
      case 'balance':
        result = service.getBalance(payload.paymentId ?? payload);
        break;
      case 'history':
        result = store.load();
        break;
      default:
        throw new RefundError('UNKNOWN_COMMAND', `unknown command: ${command}\n${USAGE}`);
    }
    return { code: 0, output: `${JSON.stringify({ ok: true, result })}\n` };
  } catch (err) {
    const code =
      err instanceof RefundError
        ? err.code
        : err instanceof SyntaxError
          ? 'INVALID_JSON'
          : 'INTERNAL_ERROR';
    return { code: 1, output: `${JSON.stringify({ error: { code, message: err.message } })}\n` };
  }
}
