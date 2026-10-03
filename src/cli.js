// CLI logic, separated from process I/O so it can be tested in-process.
import { createEngine, verifyCertificate } from './engine.js';

export function parseArgs(argv) {
  const args = { cards: {} };
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pool') args.pool = Number(argv[++i]);
    else if (a === '--card') {
      const [id, v] = argv[++i].split(':');
      args.cards[id] = Number(v);
    } else if (a === '--aging-k') args.agingK = Number(argv[++i]);
    else if (a === '--preempt-window') args.preemptWindow = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.help = true;
    else file = a;
  }
  return { args, file };
}

export function runCli(input, args = {}) {
  let config = {};
  const events = [];
  for (const line of input.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed);
    if (obj.type === 'config') {
      const { type, ...rest } = obj;
      config = { ...config, ...rest };
    } else {
      events.push(obj);
    }
  }
  if (args.pool !== undefined) config.pool = args.pool;
  if (args.cards && Object.keys(args.cards).length > 0) {
    config.cards = { ...(config.cards ?? {}), ...args.cards };
  }
  if (args.agingK !== undefined) config.agingK = args.agingK;
  if (args.preemptWindow !== undefined) config.preemptWindow = args.preemptWindow;

  const engine = createEngine(config);
  const { timeline, violations, queue, certificates } = engine.run(events);
  const output = {
    timeline,
    violations,
    queue,
    certificates,
    certificatesOk: certificates.every((c) => verifyCertificate(c).ok),
  };
  return { output, exitCode: violations.length > 0 ? 2 : 0 };
}
