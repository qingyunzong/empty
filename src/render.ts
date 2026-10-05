/**
 * Render expanded arguments into a POSIX display string while keeping
 * per-byte provenance, and reverse-edit arguments back into their
 * original source files.
 */

import { assertNoNul, isSafeArg } from './quote.js';
import type { ExpandedArg, ExpansionResult, SourceSpan } from './response.js';

export interface ByteSource {
  file: string;
  offset: number;
}

export interface RenderedCommand {
  display: string;
  /**
   * byteMap[i] identifies the source byte that display character i
   * represents, or null for bytes added by the renderer itself
   * (quote characters, escape backslashes, separating spaces).
   */
  byteMap: (ByteSource | null)[];
  args: ExpandedArg[];
  files: ReadonlyMap<string, string>;
}

/** Render one argument; returns display text and its per-byte source map. */
function renderArg(arg: ExpandedArg): { text: string; map: (ByteSource | null)[] } {
  const src = (offset: number): ByteSource => ({ file: arg.span.file, offset });
  if (isSafeArg(arg.value)) {
    return { text: arg.value, map: arg.charMap.map(src) };
  }
  let text = "'";
  const map: (ByteSource | null)[] = [null];
  for (let i = 0; i < arg.value.length; i++) {
    const ch = arg.value[i];
    if (ch === "'") {
      text += `'\\''`;
      map.push(null, null, src(arg.charMap[i]), null);
    } else {
      text += ch;
      map.push(src(arg.charMap[i]));
    }
  }
  text += "'";
  map.push(null);
  return { text, map };
}

/** Build the display string for an expansion, tracking every byte's origin. */
export function renderCommand(expansion: ExpansionResult): RenderedCommand {
  let display = '';
  const byteMap: (ByteSource | null)[] = [];
  expansion.args.forEach((arg, index) => {
    if (index > 0) {
      display += ' ';
      byteMap.push(null);
    }
    const { text, map } = renderArg(arg);
    display += text;
    byteMap.push(...map);
  });
  return { display, byteMap, args: expansion.args, files: expansion.files };
}

export interface EditRequest {
  argIndex: number;
  newValue: string;
}

export interface EditConflict {
  span: SourceSpan;
  replacements: string[];
}

export class EditConflictError extends Error {
  constructor(public readonly conflicts: EditConflict[]) {
    super(
      `conflicting edits for shared source span(s): ${conflicts
        .map((c) => `${c.span.file}:${c.span.start}:${c.span.end}`)
        .join(', ')}`,
    );
    this.name = 'EditConflictError';
  }
}

/**
 * Quote a value in response-file syntax. Identical quoting rules to the
 * display string, except tokens that would be re-read as directives or
 * includes (`@`, `%`, `#` at token start) are always quoted.
 */
export function quoteTokenForFile(value: string): string {
  assertNoNul(value);
  if (isSafeArg(value) && !/^[@%#]/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function spanKey(span: SourceSpan): string {
  return `${span.file}:${span.start}:${span.end}`;
}

/**
 * Compute updated file contents after replacing the given arguments with
 * new values. Editing is by argument index; the change is written back to
 * the original source span, so every other reference to the same source
 * (e.g. a file included twice) stays globally consistent automatically.
 *
 * Atomicity: if two requested edits target the same source span with
 * different values, an EditConflictError is thrown and nothing is applied.
 */
export function applyEdits(
  rendered: RenderedCommand,
  edits: readonly EditRequest[],
): Map<string, string> {
  const bySpan = new Map<string, { span: SourceSpan; replacement: string }>();
  const conflicts = new Map<string, EditConflict>();
  for (const edit of edits) {
    const arg = rendered.args[edit.argIndex];
    if (!arg) throw new Error(`argument index out of range: ${edit.argIndex}`);
    const replacement = quoteTokenForFile(edit.newValue);
    const key = spanKey(arg.span);
    const existing = bySpan.get(key);
    if (existing) {
      if (existing.replacement !== replacement) {
        const conflict = conflicts.get(key) ?? { span: arg.span, replacements: [existing.replacement] };
        if (!conflict.replacements.includes(replacement)) conflict.replacements.push(replacement);
        conflicts.set(key, conflict);
      }
      continue;
    }
    bySpan.set(key, { span: arg.span, replacement });
  }
  if (conflicts.size > 0) throw new EditConflictError([...conflicts.values()]);

  const byFile = new Map<string, { span: SourceSpan; replacement: string }[]>();
  for (const entry of bySpan.values()) {
    const list = byFile.get(entry.span.file) ?? [];
    list.push(entry);
    byFile.set(entry.span.file, list);
  }
  const result = new Map<string, string>();
  for (const [file, entries] of byFile) {
    const base = rendered.files.get(file);
    if (base === undefined) throw new Error(`source file not in expansion snapshot: ${file}`);
    const sorted = [...entries].sort((a, b) => b.span.start - a.span.start);
    for (let k = 1; k < sorted.length; k++) {
      if (sorted[k].span.end > sorted[k - 1].span.start) {
        throw new EditConflictError([{ span: sorted[k].span, replacements: ['<overlapping spans>'] }]);
      }
    }
    let content = base;
    for (const { span, replacement } of sorted) {
      content = content.slice(0, span.start) + replacement + content.slice(span.end);
    }
    result.set(file, content);
  }
  return result;
}
