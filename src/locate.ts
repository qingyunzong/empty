/**
 * Locate the column span of a top-level JSON string field inside one raw
 * JSONL line, so citations can point at the exact value (引用范围).
 * Returns 1-based, end-exclusive columns; null when not found.
 */
export function locateField(
  line: string,
  field: string
): { colStart: number; colEnd: number } | null {
  const key = JSON.stringify(field);
  let from = 0;
  for (;;) {
    const keyIdx = line.indexOf(key, from);
    if (keyIdx < 0) return null;
    // Key must be followed (after optional whitespace) by a colon.
    let i = keyIdx + key.length;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    if (line[i] !== ":") {
      from = keyIdx + key.length;
      continue;
    }
    i++;
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    if (line[i] !== '"') return null; // only string values are checked
    const valueStart = i;
    i++;
    while (i < line.length) {
      const ch = line[i];
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        return { colStart: valueStart + 1, colEnd: i + 1 };
      }
      i++;
    }
    return null;
  }
}
