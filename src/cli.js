import { parseArgs } from 'node:util';
import { Engine } from './engine.js';

const USAGE = `Usage: interlock replay --in <dir> --out <dir> [options]

Options:
  --pressure-tag <tag>      pressure sensor tag (default: pressure)
  --temp-tag <tag>          temperature sensor tag (default: temperature)
  --pressure-limit <n>      pressure limit in --pressure-unit (default: 1000)
  --temp-limit <n>          temperature limit in --temp-unit (default: 180)
  --pressure-unit <unit>    expected pressure unit (default: kPa)
  --temp-unit <unit>        expected temperature unit (default: C)
  --duration-ms <n>         sustained duration required to ARM (default: 3000)
  --window-ms <n>           sample validity / join window (default: 2000)
  --watermark-lag-ms <n>    watermark lag behind max event time (default: 1000)

Outputs in --out: states.jsonl, proof.json, late.log, snapshot.json
Test hook: env INTERLOCK_EXIT_AFTER_COMMITS=<n> aborts the process after n
commits (simulates a crash for recovery testing).
`;

export function main(argv) {
  const [command, ...rest] = argv;
  if (command !== 'replay') {
    process.stderr.write(USAGE);
    const ok = command === undefined || command === 'help' || command === '--help';
    process.exit(ok ? 0 : 2);
  }

  let values;
  try {
    ({ values } = parseArgs({
      args: rest,
      allowPositionals: false,
      options: {
        in: { type: 'string' },
        out: { type: 'string' },
        'pressure-tag': { type: 'string', default: 'pressure' },
        'temp-tag': { type: 'string', default: 'temperature' },
        'pressure-limit': { type: 'string', default: '1000' },
        'temp-limit': { type: 'string', default: '180' },
        'pressure-unit': { type: 'string', default: 'kPa' },
        'temp-unit': { type: 'string', default: 'C' },
        'duration-ms': { type: 'string', default: '3000' },
        'window-ms': { type: 'string', default: '2000' },
        'watermark-lag-ms': { type: 'string', default: '1000' },
      },
    }));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}`);
    process.exit(2);
  }

  if (!values.in || !values.out) {
    process.stderr.write(USAGE);
    process.exit(2);
  }

  const numeric = (name) => {
    const parsed = Number(values[name]);
    if (!Number.isFinite(parsed)) {
      process.stderr.write(`Invalid --${name}: ${values[name]}\n`);
      process.exit(2);
    }
    return parsed;
  };

  const config = {
    pressureTag: values['pressure-tag'],
    tempTag: values['temp-tag'],
    pressureLimit: numeric('pressure-limit'),
    tempLimit: numeric('temp-limit'),
    pressureUnit: values['pressure-unit'],
    tempUnit: values['temp-unit'],
    durationMs: numeric('duration-ms'),
    windowMs: numeric('window-ms'),
    watermarkLagMs: numeric('watermark-lag-ms'),
  };

  if (process.env.INTERLOCK_EXIT_AFTER_COMMITS) {
    config.crashAfterCommits = Number(process.env.INTERLOCK_EXIT_AFTER_COMMITS);
  }

  const engine = new Engine({ inDir: values.in, outDir: values.out, config });
  const summary = engine.run();
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
