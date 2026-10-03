import { Store } from './store.js';
import { BizError, CorruptionError } from './errors.js';
import { ancestorsOf, descendantsOf, validateState } from './state.js';

const USAGE = 'usage: batch-lineage <dir> <create|split|merge|link|qc|lineage|certificate|verify|state> [json-args]';

export function runCli(argv, io) {
  const out = (o) => io.stdout(JSON.stringify(o) + '\n');
  try {
    const [dir, cmd, argJson] = argv;
    if (!dir || !cmd) throw new BizError(USAGE);
    let arg = {};
    if (argJson !== undefined) {
      try { arg = JSON.parse(argJson); } catch { throw new BizError('args must be valid JSON'); }
    }
    const store = Store.open(dir);
    try {
      switch (cmd) {
        case 'create': case 'split': case 'merge': case 'link': case 'qc': {
          const tx = store.begin();
          tx[cmd](arg);
          const cert = tx.commit();
          out({ ok: true, certificate: cert });
          break;
        }
        case 'lineage':
          out({
            ok: true,
            id: arg.id,
            ancestors: [...ancestorsOf(store.state, arg.id)].sort(),
            descendants: [...descendantsOf(store.state, arg.id)].sort(),
          });
          break;
        case 'certificate':
          out({ ok: true, certificate: store.latestCertificate() });
          break;
        case 'verify': {
          const violations = validateState(store.state);
          out({ ok: true, valid: violations.length === 0, violations });
          break;
        }
        case 'state':
          out({ ok: true, state: store.state });
          break;
        default:
          throw new BizError(`unknown command: ${cmd}`);
      }
    } finally {
      store.close();
    }
    return 0;
  } catch (e) {
    const corruption = e instanceof CorruptionError;
    io.stderr(JSON.stringify({
      ok: false,
      error: { type: corruption ? 'corruption' : 'business', message: e.message },
    }) + '\n');
    return corruption ? 2 : 1;
  }
}
