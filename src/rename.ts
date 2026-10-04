import { KEYWORDS, LexError, lex, Token } from "./lexer.js";
import { parse, ParseError } from "./parser.js";
import { analyze, Decl } from "./scope.js";

/** A single byte edit: replace source bytes [start, end) with newText. */
export interface Edit {
  /** Start offset in UTF-8 bytes. */
  start: number;
  /** End offset (exclusive) in UTF-8 bytes. */
  end: number;
  newText: string;
}

export type RenameResult =
  | { ok: true; edits: Edit[] }
  | { ok: false; reason: string };

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Maps every UTF-16 index boundary in `source` to its UTF-8 byte offset. */
function buildCharToByte(source: string): number[] {
  const map = new Array<number>(source.length + 1);
  let byte = 0;
  let i = 0;
  for (const ch of source) {
    map[i] = byte;
    if (ch.length === 2) map[i + 1] = byte;
    byte += Buffer.byteLength(ch, "utf8");
    i += ch.length;
  }
  map[source.length] = byte;
  return map;
}

function byteToChar(charToByte: number[], byteOffset: number): number {
  let lo = 0;
  let hi = charToByte.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (charToByte[mid] <= byteOffset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function contains(token: Token, index: number): boolean {
  return token.start <= index && index < token.end;
}

/**
 * Plans a rename of the declaration found at `offset` (a UTF-8 byte offset
 * pointing at the declaration name or at any reference to it).
 *
 * Only references that resolve to that exact declaration are rewritten.
 * If the new name would capture any reference — or be captured by another
 * binding — the whole operation is rejected and no edits are returned.
 */
export function planRename(source: string, offset: number, newName: string): RenameResult {
  if (!IDENT_RE.test(newName) || KEYWORDS.has(newName)) {
    return { ok: false, reason: `invalid identifier: ${JSON.stringify(newName)}` };
  }

  const charToByte = buildCharToByte(source);
  const charIndex = byteToChar(charToByte, offset);

  let analysis;
  try {
    analysis = analyze(parse(lex(source)));
  } catch (err) {
    if (err instanceof LexError || err instanceof ParseError) {
      return { ok: false, reason: `parse error: ${err.message}` };
    }
    throw err;
  }

  // Locate the target declaration: a declaration name at the offset, or a
  // reference at the offset that resolves to one.
  let target: Decl | null = null;
  for (const decl of analysis.decls) {
    if (contains(decl.token, charIndex)) {
      target = decl;
      break;
    }
  }
  if (target === null) {
    for (const ref of analysis.refs) {
      if (contains(ref.token, charIndex)) {
        if (ref.decl === null) {
          return { ok: false, reason: `cannot rename unresolved reference ${JSON.stringify(ref.token.value)}` };
        }
        target = ref.decl;
        break;
      }
    }
  }
  if (target === null) {
    return { ok: false, reason: `no identifier at byte offset ${offset}` };
  }

  const oldName = target.name;
  if (newName === oldName) {
    return { ok: false, reason: `new name is identical to the old name ${JSON.stringify(oldName)}` };
  }

  const scope = target.scope;
  if (scope.decls.has(newName)) {
    return {
      ok: false,
      reason: `name ${JSON.stringify(newName)} is already declared in the same scope`,
    };
  }

  // Capture check: tentatively apply the rename to the scope tree, re-resolve
  // every reference, and require that each reference keeps its original
  // binding. Any change means a capture — reject the whole operation.
  const before = analysis.refs.map((ref) => ref.decl);
  scope.decls.delete(oldName);
  target.name = newName;
  scope.decls.set(newName, target);
  try {
    for (let i = 0; i < analysis.refs.length; i++) {
      const ref = analysis.refs[i];
      const renamed = before[i] === target;
      const text = renamed ? newName : ref.token.value;
      const now = ref.scope.lookup(text);
      const expected = before[i];
      if (now !== expected) {
        const byte = charToByte[ref.token.start];
        if (renamed) {
          return {
            ok: false,
            reason:
              `renaming ${JSON.stringify(oldName)} to ${JSON.stringify(newName)} would let the ` +
              `reference at byte ${byte} be captured by another declaration of ${JSON.stringify(newName)}`,
          };
        }
        return {
          ok: false,
          reason:
            `renaming ${JSON.stringify(oldName)} to ${JSON.stringify(newName)} would capture the ` +
            `reference ${JSON.stringify(ref.token.value)} at byte ${byte}`,
        };
      }
    }
  } finally {
    scope.decls.delete(newName);
    target.name = oldName;
    scope.decls.set(oldName, target);
  }

  // Build the byte edit plan: the declaration name plus every reference
  // that resolves to it.
  const tokens: Token[] = [target.token];
  for (const ref of analysis.refs) {
    if (ref.decl === target) tokens.push(ref.token);
  }
  const edits: Edit[] = tokens
    .map((tok) => ({ start: charToByte[tok.start], end: charToByte[tok.end], newText: newName }))
    .sort((a, b) => a.start - b.start);
  return { ok: true, edits };
}

/** Applies a byte edit plan to `source` and returns the rewritten source. */
export function applyEdits(source: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  const buf = Buffer.from(source, "utf8");
  const parts: Buffer[] = [];
  let pos = 0;
  for (const edit of sorted) {
    if (edit.start < pos) throw new Error("overlapping edits");
    parts.push(buf.subarray(pos, edit.start), Buffer.from(edit.newText, "utf8"));
    pos = edit.end;
  }
  parts.push(buf.subarray(pos));
  return Buffer.concat(parts).toString("utf8");
}
