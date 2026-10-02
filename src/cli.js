'use strict';

const { plan, verify, AuditError } = require('./sampler');

const USAGE =
  'usage: audit-sample [input.json]\n' +
  '  Reads a sampling plan from JSON (file argument or stdin),\n' +
  '  writes the result JSON to stdout. Exit code 2 on failure.\n' +
  '  Input: {seed, version, strata: {name: [entries]}, quotas: {name: n}, prev?}\n' +
  '  With {"verify": true, "result": <previous output>} the result is verified instead.\n';

// In-process CLI core. `io` provides all side effects:
//   io.readStdin()      -> string
//   io.readFile(path)   -> string
//   io.write(string)    -> void (stdout)
// Returns the process exit code (0 success, 2 failure).
function run(argv, io) {
  const args = argv.slice(2);
  let file = null;
  for (const arg of args) {
    if (arg === '--help' || arg === '-h') {
      io.write(USAGE);
      return 0;
    }
    file = arg;
  }

  const emitError = (code, message, details) => {
    const error = { code, message };
    if (details !== undefined) error.details = details;
    io.write(JSON.stringify({ ok: false, error }, null, 2) + '\n');
    return 2;
  };

  let input;
  try {
    const raw = file === null ? io.readStdin() : io.readFile(file);
    input = JSON.parse(raw);
  } catch (err) {
    return emitError('INPUT_INVALID', `cannot read/parse input JSON: ${err.message}`);
  }

  try {
    if (input && input.verify === true) {
      if (!input.result || typeof input.result !== 'object') {
        return emitError('INPUT_INVALID', 'verify mode requires a "result" object');
      }
      const report = verify(input, input.result);
      io.write(JSON.stringify(report, null, 2) + '\n');
      return report.ok ? 0 : 2;
    }
    const result = plan(input);
    io.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof AuditError) {
      return emitError(err.code, err.message, err.details);
    }
    return emitError('INTERNAL', err && err.message ? err.message : String(err));
  }
}

module.exports = { run, USAGE };
