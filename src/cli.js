import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { issueCert, verifyCert } from './cert.js';
import { E, EvpackError } from './errors.js';

const EXIT_CODES = {
  [E.DUP_RULE]: 2,
  [E.EVIDENCE_GONE]: 3,
  [E.UNDECIDED]: 4,
  [E.CERT_MISMATCH]: 5,
};

function stateDir() {
  return process.env.EVPACK_HOME ?? path.join(process.cwd(), '.evpack');
}

function stateFile() {
  return path.join(stateDir(), 'state.json');
}

function loadState() {
  const file = stateFile();
  if (!fs.existsSync(file)) return new Store();
  return Store.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function saveState(store) {
  fs.mkdirSync(stateDir(), { recursive: true });
  fs.writeFileSync(stateFile(), JSON.stringify(store.toJSON(), null, 2));
}

function readJsonArg(arg, what) {
  if (fs.existsSync(arg)) return JSON.parse(fs.readFileSync(arg, 'utf8'));
  try {
    return JSON.parse(arg);
  } catch {
    throw new EvpackError('E_USAGE', `cannot parse ${what} as JSON: ${arg}`);
  }
}

const USAGE = `evpack - offline regulatory evidence pack validator

usage:
  evpack load <dir>            import evidence pack (evidence.jsonl [+ rules.json])
  evpack rule add <json|file>  add an exclusion rule
  evpack retract <evidenceKey> retract one evidence row
  evpack verify <claim|file>   evaluate a claim (pass/fail/undecided)
  evpack cert <claim|file> [outfile]  issue a reviewable certificate
  evpack check <certfile>      verify a certificate against current state

state directory: $EVPACK_HOME or ./.evpack
exit codes: 0 ok, 2 E_DUP_RULE, 3 E_EVIDENCE_GONE, 4 E_UNDECIDED, 5 E_CERT_MISMATCH, 1 other`;

function cmdLoad(dir) {
  const evidenceFile = path.join(dir, 'evidence.jsonl');
  if (!fs.existsSync(evidenceFile)) {
    throw new EvpackError('E_USAGE', `missing ${evidenceFile}`);
  }
  const store = new Store();
  const lines = fs.readFileSync(evidenceFile, 'utf8').split('\n').filter((l) => l.trim());
  for (const line of lines) store.addEvidence(JSON.parse(line));
  const rulesFile = path.join(dir, 'rules.json');
  if (fs.existsSync(rulesFile)) {
    for (const rule of JSON.parse(fs.readFileSync(rulesFile, 'utf8'))) store.addRule(rule);
  }
  saveState(store);
  return { loaded: { evidence: store.rows.size, rules: store.rules.size }, stateDir: stateDir() };
}

function cmdVerify(claimArg) {
  const engine = new Engine(loadState());
  const result = engine.evaluate(readJsonArg(claimArg, 'claim'));
  const { relevantKeys, ...out } = result;
  return { result: out, conclusion: result.conclusion };
}

function cmdCert(claimArg, outfile) {
  const engine = new Engine(loadState());
  const cert = issueCert(engine, readJsonArg(claimArg, 'claim'));
  const text = JSON.stringify(cert, null, 2);
  if (outfile) {
    fs.writeFileSync(outfile, `${text}\n`);
    return { certFile: outfile, conclusion: cert.conclusion };
  }
  return { cert };
}

function cmdCheck(certFile) {
  const engine = new Engine(loadState());
  const cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
  verifyCert(engine, cert);
  return { cert: 'ok', conclusion: cert.conclusion };
}

export function run(argv, out = process.stdout, err = process.stderr) {
  const [cmd, ...args] = argv;
  try {
    let printed;
    switch (cmd) {
      case 'load':
        printed = cmdLoad(args[0]);
        break;
      case 'rule':
        if (args[0] !== 'add') throw new EvpackError('E_USAGE', USAGE);
        {
          const store = loadState();
          const rule = store.addRule(readJsonArg(args[1], 'rule'));
          saveState(store);
          printed = { added: rule.id, priority: rule.priority };
        }
        break;
      case 'retract': {
        const store = loadState();
        store.retract(args[0]);
        saveState(store);
        printed = { retracted: args[0] };
        break;
      }
      case 'verify': {
        const { result, conclusion } = cmdVerify(args[0]);
        printed = result;
        out.write(`${JSON.stringify(printed, null, 2)}\n`);
        if (conclusion === 'undecided') {
          throw new EvpackError(E.UNDECIDED, 'claim is undecided: unresolved unknown/retracted evidence');
        }
        return 0;
      }
      case 'cert':
        printed = cmdCert(args[0], args[1]);
        break;
      case 'check':
        printed = cmdCheck(args[0]);
        break;
      default:
        err.write(`${USAGE}\n`);
        return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 1;
    }
    out.write(`${JSON.stringify(printed, null, 2)}\n`);
    return 0;
  } catch (e) {
    const code = e instanceof EvpackError ? e.code : 'E_INTERNAL';
    err.write(`${JSON.stringify({ error: code, message: e.message })}\n`);
    return EXIT_CODES[code] ?? 1;
  }
}
