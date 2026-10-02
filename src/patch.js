// Structured patch model.
//
// A patch is an array of per-file entries:
//   { file: "path", hunks: [ <hunk>, ... ] }
//
// Supported hunks (applied sequentially against the file's current content):
//   { op: "insert",  context: "...", text: "...", position: "before"|"after" }
//       Insert `text` before/after the unique occurrence of `context`.
//       An empty/absent context targets the start ("before") or end ("after")
//       of the file.
//   { op: "replace", old: "...", new: "..." }
//       Replace the unique occurrence of `old` with `new`.
//   { op: "delete",  old: "..." }
//       Remove the unique occurrence of `old`.
//
// A hunk whose anchor (`context`/`old`) does not occur exactly once cannot be
// located and raises PatchApplyError.

export class PatchApplyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchApplyError';
  }
}

function countOccurrences(haystack, needle) {
  if (needle === '') return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function locateUnique(content, anchor, what) {
  const count = countOccurrences(content, anchor);
  if (count === 0) {
    throw new PatchApplyError(`${what} not found in content: ${JSON.stringify(anchor)}`);
  }
  if (count > 1) {
    throw new PatchApplyError(`${what} is ambiguous (${count} occurrences): ${JSON.stringify(anchor)}`);
  }
  return content.indexOf(anchor);
}

export function applyHunk(content, hunk) {
  switch (hunk.op) {
    case 'insert': {
      const text = hunk.text ?? '';
      const position = hunk.position ?? 'after';
      const context = hunk.context ?? '';
      if (context === '') {
        return position === 'before' ? text + content : content + text;
      }
      const at = locateUnique(content, context, 'insert context');
      const offset = position === 'before' ? at : at + context.length;
      return content.slice(0, offset) + text + content.slice(offset);
    }
    case 'replace': {
      const at = locateUnique(content, hunk.old ?? '', 'replace anchor');
      return content.slice(0, at) + (hunk.new ?? '') + content.slice(at + (hunk.old ?? '').length);
    }
    case 'delete': {
      const at = locateUnique(content, hunk.old ?? '', 'delete anchor');
      return content.slice(0, at) + content.slice(at + (hunk.old ?? '').length);
    }
    default:
      throw new PatchApplyError(`unknown hunk op: ${JSON.stringify(hunk.op)}`);
  }
}

// Applies a structured patch to the file store (mutated in place).
export function applyPatch(store, patch) {
  for (const entry of patch ?? []) {
    let content = store[entry.file] ?? '';
    for (const hunk of entry.hunks ?? []) {
      try {
        content = applyHunk(content, hunk);
      } catch (err) {
        if (err instanceof PatchApplyError) {
          throw new PatchApplyError(`file ${JSON.stringify(entry.file)}: ${err.message}`);
        }
        throw err;
      }
    }
    store[entry.file] = content;
  }
  return store;
}
