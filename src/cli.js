#!/usr/bin/env node
// JSONL CLI. Reads one command object per line from stdin, writes one result
// object per line to stdout: {ok:true, op, diff:{added,removed,reversals,
// batches,proof}}. Any error is written to stderr as
// {ok:false,error:{code,message}} and the process exits with code 10.
import { pathToFileURL } from 'node:url';
import { Store } from './persist.js';
import { EngineError } from './engine.js';

function parseArgs(argv) {
  let dir = './.state';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--state') {
      dir = argv[i + 1];
      i += 1;
    }
  }
  return { dir };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// Returns the process exit code (0 ok, 10 on first error). IO is injectable
// so tests can run the CLI in-process.
export async function runCli({ input, dir, stdout, stderr }) {
  const store = Store.open(dir);
  for (const line of input.split('\n')) {
    if (!line.trim()) continue;
    let cmd;
    try {
      cmd = JSON.parse(line);
    } catch {
      stderr(`${JSON.stringify({ ok: false, error: { code: 'BAD_JSON', message: `invalid JSON line: ${line.slice(0, 120)}` } })}\n`);
      return 10;
    }
    try {
      const diff = store.apply(cmd);
      stdout(`${JSON.stringify({ ok: true, op: cmd.op, diff })}\n`);
    } catch (e) {
      const code = e instanceof EngineError ? e.code : 'INTERNAL';
      stderr(`${JSON.stringify({ ok: false, error: { code, message: e.message } })}\n`);
      return 10;
    }
  }
  return 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const { dir } = parseArgs(process.argv.slice(2));
  const input = await readStdin();
  const code = await runCli({
    input,
    dir,
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(code);
}
