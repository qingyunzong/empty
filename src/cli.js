import { certifyDir } from './certify.js';

const USAGE = [
  'Usage: trace certify --in <dir> --out <dir> [options]',
  '',
  'Options:',
  '  --window <ms>      event-time join window around a tightening (default 500)',
  '  --lateness <ms>    watermark lag: watermark = max(eventTs) - lateness (default 0)',
  '  --angle-min <deg>  minimum acceptable tightening angle (default 0)',
  '  --angle-max <deg>  maximum acceptable tightening angle (default 360)',
  '',
].join('\n');

function parseNumber(flag, value) {
  const n = Number(value);
  if (value === undefined || !Number.isFinite(n)) {
    throw new Error(`${flag} requires a finite number, got "${value}"`);
  }
  return n;
}

function parseCertifyArgs(rest) {
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--in':
        opts.inDir = rest[++i];
        break;
      case '--out':
        opts.outDir = rest[++i];
        break;
      case '--window':
        opts.windowMs = parseNumber('--window', rest[++i]);
        break;
      case '--lateness':
        opts.latenessMs = parseNumber('--lateness', rest[++i]);
        break;
      case '--angle-min':
        opts.angleMin = parseNumber('--angle-min', rest[++i]);
        break;
      case '--angle-max':
        opts.angleMax = parseNumber('--angle-max', rest[++i]);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!opts.inDir || !opts.outDir) throw new Error('--in and --out are required');
  return opts;
}

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd !== 'certify') {
    process.stderr.write(USAGE);
    return cmd === undefined || cmd === 'help' || cmd === '--help' ? 0 : 2;
  }
  let opts;
  try {
    opts = parseCertifyArgs(rest);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  const { inDir, outDir, ...engineOpts } = opts;
  let result;
  try {
    result = certifyDir(inDir, outDir, engineOpts);
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    return 1;
  }
  const bolts = new Set(result.certs.map((c) => c.bolt));
  process.stdout.write(
    `certify: ${result.certs.length} cert version(s) for ${bolts.size} bolt(s), ` +
      `${result.voids.length} void(s), ${result.late.length} late, ${result.errors.length} error(s)\n`,
  );
  for (const cert of result.final.sort((a, b) => (a.bolt < b.bolt ? -1 : 1))) {
    process.stdout.write(
      `  ${cert.bolt}: ${cert.status} v${cert.version}` +
        (cert.reason ? ` (${cert.reason})` : '') +
        (cert.lot ? ` lot=${cert.lot}` : '') +
        '\n',
    );
  }
  if (result.errors.length) {
    process.stderr.write(`${result.errors.length} error(s) recorded in errors.jsonl\n`);
  }
  return 0;
}
