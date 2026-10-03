import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { initStore, loadStore, query, undo } from './store.js';
import { UndoError } from './core.js';

export const USAGE = `usage:
  node cli.js init   --dir <stateDir> --nodes <nodes.json>
  node cli.js query  --dir <stateDir> --root <id> --phrase "a b" [--slop N]
  node cli.js undo   --dir <stateDir> --root <id> --phrase "a b" [--slop N] --budget N
  node cli.js status --dir <stateDir>`;

// In-process CLI entry: returns { code, stdout, stderr } so it can be tested
// without spawning a child process.
export function runCli(argv) {
  const [command, ...rest] = argv;
  const ok = (value) => ({ code: 0, stdout: JSON.stringify(value, null, 2) + '\n', stderr: '' });
  const fail = (err) => ({
    code: 1,
    stdout: '',
    stderr:
      JSON.stringify({
        ok: false,
        error: {
          code: err instanceof UndoError ? err.code : 'INTERNAL_ERROR',
          message: err.message,
        },
      }) + '\n',
  });
  const parse = (options) => parseArgs({ args: rest, options }).values;

  try {
    switch (command) {
      case 'init': {
        const v = parse({ dir: { type: 'string' }, nodes: { type: 'string' } });
        const nodes = JSON.parse(fs.readFileSync(v.nodes, 'utf8'));
        return ok(initStore(v.dir, nodes));
      }
      case 'query': {
        const v = parse({
          dir: { type: 'string' },
          root: { type: 'string' },
          phrase: { type: 'string' },
          slop: { type: 'string' },
        });
        return ok({
          ok: true,
          hits: query(v.dir, { rootId: v.root, phrase: v.phrase, slop: Number(v.slop ?? 0) }),
        });
      }
      case 'undo': {
        const v = parse({
          dir: { type: 'string' },
          root: { type: 'string' },
          phrase: { type: 'string' },
          slop: { type: 'string' },
          budget: { type: 'string' },
        });
        const result = undo(v.dir, {
          rootId: v.root,
          phrase: v.phrase,
          slop: Number(v.slop ?? 0),
          budget: Number(v.budget),
        });
        if (!result.ok) return { code: 1, stdout: '', stderr: JSON.stringify(result) + '\n' };
        return ok(result);
      }
      case 'status': {
        const v = parse({ dir: { type: 'string' } });
        const { nodes, batches } = loadStore(v.dir);
        return ok({
          ok: true,
          nodes: nodes.map((n) => ({
            id: n.id,
            parentId: n.parentId ?? null,
            amount: n.amount,
            state: n.state,
          })),
          batches: batches.map((b) => b.batchId),
        });
      }
      default:
        return { code: command ? 2 : 0, stdout: '', stderr: USAGE + '\n' };
    }
  } catch (err) {
    return fail(err);
  }
}
