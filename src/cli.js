import { readFileSync, writeFileSync } from 'node:fs';
import { parseJsonl } from './jsonl.js';
import { mergeDatasets, MergeError } from './merge.js';

export const USAGE =
  'usage: merge <base.jsonl> <left.jsonl> <right.jsonl> [--out result.jsonl] [--conflicts conflicts.json]';

function parseArgs(argv) {
  const positional = [];
  let out = 'result.jsonl';
  let conflicts = 'conflicts.json';
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out') out = argv[++i];
    else if (arg === '--conflicts') conflicts = argv[++i];
    else if (arg.startsWith('--out=')) out = arg.slice('--out='.length);
    else if (arg.startsWith('--conflicts=')) conflicts = arg.slice('--conflicts='.length);
    else if (arg === '-h' || arg === '--help') return { help: true };
    else positional.push(arg);
  }
  return { positional, out, conflicts };
}

function readDataset(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new MergeError('IO', 0, `cannot read ${path}: ${err.message}`);
  }
  return parseJsonl(text, path);
}

/**
 * Runs the merge CLI. Returns { status, stdout, stderr } without touching
 * process globals, so it can be tested in-process.
 */
export function runCli(argv) {
  const args = parseArgs(argv);
  if (args.help) return { status: 0, stdout: `${USAGE}\n`, stderr: '' };
  if (!args.positional || args.positional.length !== 3) {
    return { status: 2, stdout: '', stderr: `${JSON.stringify({ code: 'USAGE', line: 0, msg: USAGE })}\n` };
  }
  const [baseFile, leftFile, rightFile] = args.positional;
  try {
    const base = readDataset(baseFile);
    const left = readDataset(leftFile);
    const right = readDataset(rightFile);
    const { result, conflicts } = mergeDatasets(base, left, right);
    const resultText = result.map((rec) => JSON.stringify(rec)).join('\n');
    writeFileSync(args.out, resultText === '' ? '' : `${resultText}\n`);
    writeFileSync(args.conflicts, `${JSON.stringify({ conflicts }, null, 2)}\n`);
    return {
      status: 0,
      stdout: `merged=${result.length} conflicts=${conflicts.length} out=${args.out} conflictsOut=${args.conflicts}\n`,
      stderr: '',
    };
  } catch (err) {
    if (err instanceof MergeError) {
      return {
        status: 2,
        stdout: '',
        stderr: `${JSON.stringify({ code: err.code, line: err.line, msg: err.message })}\n`,
      };
    }
    throw err;
  }
}
