/**
 * POSIX shell word quoting and an independent decoder.
 *
 * No shell is ever started: `buildCommand` only produces a display string,
 * and `parseCommand` is a self-contained tokenizer for the POSIX shell
 * word syntax (single quotes, double quotes, backslash escapes, line
 * continuations, blank separators).
 */

const SAFE_RE = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function assertNoNul(value: string, what = 'argument'): void {
  if (value.includes('\0')) {
    throw new Error(`NUL byte is not allowed in ${what}`);
  }
}

/** True when `arg` needs no quoting in a POSIX shell word. */
export function isSafeArg(arg: string): boolean {
  return SAFE_RE.test(arg);
}

/** Quote one argument as a POSIX shell word. Throws on NUL bytes. */
export function quoteArg(arg: string): string {
  assertNoNul(arg);
  if (isSafeArg(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Build a display string from structured arguments. Never starts a shell. */
export function buildCommand(args: readonly string[]): string {
  return args.map(quoteArg).join(' ');
}

const BLANKS = new Set([' ', '\t', '\n']);
const DQUOTE_ESCAPABLE = new Set(['$', '`', '"', '\\', '\n']);

/**
 * Independent decoder for the display string produced by `buildCommand`.
 * Performs no expansions (`$`, backticks are kept literal) and never
 * starts a shell. Throws on malformed input and NUL bytes.
 */
export function parseCommand(cmd: string): string[] {
  assertNoNul(cmd, 'command string');
  const args: string[] = [];
  let current: string | null = null;
  let i = 0;
  while (i < cmd.length) {
    const c = cmd[i];
    if (current === null) {
      if (BLANKS.has(c)) { i++; continue; }
      current = '';
    }
    if (BLANKS.has(c)) {
      args.push(current);
      current = null;
      i++;
      continue;
    }
    if (c === '\\') {
      if (i + 1 >= cmd.length) throw new Error('dangling backslash');
      const next = cmd[i + 1];
      if (next !== '\n') current += next; // backslash-newline is a continuation
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = cmd.indexOf("'", i + 1);
      if (end < 0) throw new Error('unterminated single quote');
      current += cmd.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      for (;;) {
        if (i >= cmd.length) throw new Error('unterminated double quote');
        const d = cmd[i];
        if (d === '"') { i++; break; }
        if (d === '\\' && i + 1 < cmd.length && DQUOTE_ESCAPABLE.has(cmd[i + 1])) {
          if (cmd[i + 1] !== '\n') current += cmd[i + 1];
          i += 2;
          continue;
        }
        current += d;
        i++;
      }
      continue;
    }
    current += c;
    i++;
  }
  if (current !== null) args.push(current);
  return args;
}
