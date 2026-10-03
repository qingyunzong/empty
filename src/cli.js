import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { Certifier, DEFAULTS } from './certify.js';
import { parseLine } from './events.js';
import { TraceError } from './errors.js';

const USAGE = `Usage: trace certify --in <dir> --out <dir> [options]

Options:
  --window-ms <n>         join window around a tightening (default ${DEFAULTS.windowMs})
  --watermark-lag-ms <n>  watermark lag for late-event detection (default ${DEFAULTS.watermarkLagMs})
  --angle-min <n>         minimum acceptable angle (default ${DEFAULTS.angleMin})
  --angle-max <n>         maximum acceptable angle (default ${DEFAULTS.angleMax})
`;

function toNumber(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new TraceError('BAD_ARGS', `option ${name} must be a number`);
  return n;
}

function writeJsonl(file, rows) {
  const body = rows.map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(file, body.length > 0 ? body + '\n' : '');
}

export function runCertify(args, io) {
  const { values } = parseArgs({
    args,
    options: {
      in: { type: 'string' },
      out: { type: 'string' },
      'window-ms': { type: 'string' },
      'watermark-lag-ms': { type: 'string' },
      'angle-min': { type: 'string' },
      'angle-max': { type: 'string' },
    },
    strict: true,
  });

  if (!values.in || !values.out) {
    throw new TraceError('BAD_ARGS', 'certify requires --in <dir> and --out <dir>');
  }

  const options = {};
  if (values['window-ms'] !== undefined) options.windowMs = toNumber(values['window-ms'], '--window-ms');
  if (values['watermark-lag-ms'] !== undefined) options.watermarkLagMs = toNumber(values['watermark-lag-ms'], '--watermark-lag-ms');
  if (values['angle-min'] !== undefined) options.angleMin = toNumber(values['angle-min'], '--angle-min');
  if (values['angle-max'] !== undefined) options.angleMax = toNumber(values['angle-max'], '--angle-max');

  const certifier = new Certifier(options);

  const files = fs
    .readdirSync(values.in)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
  for (const file of files) {
    const full = path.join(values.in, file);
    const lines = fs.readFileSync(full, 'utf8').split('\n');
    lines.forEach((line, idx) => {
      if (line.trim() === '') return;
      const event = parseLine(line, `${file}:${idx + 1}`);
      certifier.ingest(event);
    });
  }

  fs.mkdirSync(values.out, { recursive: true });
  const certs = certifier.emissions.filter((e) => e.stream === 'certs').map((e) => e.record);
  const voids = certifier.emissions.filter((e) => e.stream === 'void').map((e) => e.record);
  writeJsonl(path.join(values.out, 'certs.jsonl'), certs);
  writeJsonl(path.join(values.out, 'void.jsonl'), voids);
  writeJsonl(path.join(values.out, 'late.log'), certifier.late);

  for (const report of certifier.reports) {
    io.stderr.write(`${report.code} ${JSON.stringify(report)}\n`);
  }

  const summary = certifier.summary();
  io.stdout.write(
    `certify: events=${summary.events} certs=${summary.certs} voids=${summary.voids} ` +
      `late=${summary.late} reports=${summary.reports} watermark=${summary.watermark}\n`,
  );
  return 0;
}

export function main(argv, io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, ...rest] = argv;
  if (command !== 'certify') {
    io.stderr.write(USAGE);
    return 2;
  }
  try {
    return runCertify(rest, io);
  } catch (err) {
    if (err instanceof TraceError) {
      io.stderr.write(`${err.code} ${err.message}\n`);
      return err.code === 'BAD_ARGS' ? 2 : 1;
    }
    throw err;
  }
}
