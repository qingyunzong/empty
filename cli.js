'use strict';

const { FormulaStore } = require('./lib/store');
const { FormulaError } = require('./lib/formula');

const NAME = '[A-Za-z_][A-Za-z0-9_]*';
const COMMANDS = [
  { re: new RegExp(`^def\\s+(${NAME})\\s*=\\s*(.+)$`), run: (s, m) => s.def(m[1], m[2]) },
  { re: new RegExp(`^correct\\s+(${NAME})\\s*=\\s*(.+)$`), run: (s, m) => s.correct(m[1], m[2]) },
  { re: new RegExp(`^undo\\s+(${NAME})\\s*$`), run: (s, m) => s.undo(m[1]) },
  { re: new RegExp(`^redo\\s+(${NAME})\\s*$`), run: (s, m) => s.redo(m[1]) },
  { re: new RegExp(`^certify\\s+(${NAME})\\s*$`), run: (s, m) => s.certify(m[1]) },
];

function run(input, stdout, stderr) {
  const store = new FormulaStore();
  const lines = input.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    try {
      const matched = COMMANDS.find((c) => c.re.test(line));
      if (!matched) throw new FormulaError(`unknown command: '${line}'`);
      const m = matched.re.exec(line);
      const result = matched.run(store, m);
      stdout(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      if (err instanceof FormulaError) {
        stderr(`error: ${err.message}`);
        return 1;
      }
      throw err;
    }
  }
  return 0;
}

if (require.main === module) {
  const input = require('node:fs').readFileSync(0, 'utf8');
  const code = run(input, (s) => console.log(s), (s) => console.error(s));
  process.exit(code);
}

module.exports = { run };
