import fs from 'node:fs';
import { parse } from './parser.js';
import { typecheck } from './typecheck.js';
import { compileProgram } from './compile.js';
import { parseHistory } from './history.js';
import { runCheck } from './api.js';
import { buildOutput, verifyOutput } from './certificate.js';

export const EXIT = { LINEARIZABLE: 0, NON_LINEARIZABLE: 1, ERROR: 2, UNKNOWN: 3 };

const USAGE = [
  'usage:',
  '  linck check <rules.dsl> <history.jsonl> [--json out.json]',
  '  linck verify <out.json>',
].join('\n');

function fail(msg, io) {
  io.stderr.write(`${msg}\n`);
  return EXIT.ERROR;
}

function readFile(path) {
  try {
    return fs.readFileSync(path, 'utf8');
  } catch (e) {
    return { error: `cannot read ${path}: ${e.message}` };
  }
}

function cmdCheck(args, io) {
  const positional = [];
  let jsonOut = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') {
      if (i + 1 >= args.length) return fail('error: --json requires a path\n' + USAGE, io);
      jsonOut = args[++i];
    } else if (args[i].startsWith('--')) {
      return fail(`error: unknown option ${args[i]}\n` + USAGE, io);
    } else {
      positional.push(args[i]);
    }
  }
  if (positional.length !== 2) return fail('error: check expects <rules.dsl> and <history.jsonl>\n' + USAGE, io);
  const [rulesPath, historyPath] = positional;

  const rulesSrc = readFile(rulesPath);
  if (rulesSrc.error) return fail(`error: ${rulesSrc.error}`, io);
  const historySrc = readFile(historyPath);
  if (historySrc.error) return fail(`error: ${historySrc.error}`, io);

  let compiled;
  try {
    const ast = parse(rulesSrc);
    const { ops } = typecheck(ast);
    compiled = compileProgram(ast, ops);
  } catch (e) {
    if (e.isDslError) return fail(`${rulesPath}: ${e.message}`, io);
    throw e;
  }

  let history;
  try {
    history = parseHistory(historySrc);
  } catch (e) {
    if (e.isHistoryError) return fail(`${historyPath}: ${e.message}`, io);
    throw e;
  }

  for (const e of history.events) {
    if (!compiled.ops.has(e.op)) return fail(`${historyPath}: line ${e.line}: undeclared op "${e.op}"`, io);
  }
  for (const c of history.corrections) {
    if (!compiled.ops.has(c.op)) return fail(`${historyPath}: line ${c.line}: undeclared op "${c.op}"`, io);
  }

  const results = runCheck(compiled, history);
  const output = buildOutput(compiled, results);

  results.forEach((r, i) => {
    const status = i === results.length - 1 ? 'CURRENT' : 'SUPERSEDED';
    io.stdout.write(`version ${i + 1}: ${r.verdict} (${status})\n`);
  });
  io.stdout.write(`verdict: ${output.verdict}\n`);

  if (jsonOut) {
    try {
      fs.writeFileSync(jsonOut, JSON.stringify(output, null, 2) + '\n');
    } catch (e) {
      return fail(`error: cannot write ${jsonOut}: ${e.message}`, io);
    }
    io.stdout.write(`certificate written to ${jsonOut}\n`);
  }
  return EXIT[output.verdict];
}

function cmdVerify(args, io) {
  if (args.length !== 1 || args[0].startsWith('--')) {
    return fail('error: verify expects <out.json>\n' + USAGE, io);
  }
  const src = readFile(args[0]);
  if (src.error) return fail(`error: ${src.error}`, io);
  let obj;
  try {
    obj = JSON.parse(src);
  } catch (e) {
    return fail(`${args[0]}: invalid JSON: ${e.message}`, io);
  }
  const { ok, errors } = verifyOutput(obj);
  for (const v of obj && Array.isArray(obj.versions) ? obj.versions : []) {
    io.stdout.write(`version ${v.version}: ${v.verdict} (${v.status})\n`);
  }
  if (ok) {
    io.stdout.write('certificate valid\n');
    return EXIT.LINEARIZABLE;
  }
  for (const e of errors) io.stderr.write(`invalid: ${e}\n`);
  io.stdout.write('certificate invalid\n');
  return EXIT.NON_LINEARIZABLE;
}

export function main(argv, io = process) {
  const [cmd, ...rest] = argv;
  if (cmd === 'check') return cmdCheck(rest, io);
  if (cmd === 'verify') return cmdVerify(rest, io);
  io.stderr.write(`${USAGE}\n`);
  return EXIT.ERROR;
}
