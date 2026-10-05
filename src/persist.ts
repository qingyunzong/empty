import * as fs from "node:fs";

/** Append one JSON line and fsync so the record survives a crash. */
export function appendJsonlSync(file: string, value: unknown): void {
  fs.appendFileSync(file, JSON.stringify(value) + "\n");
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomically replace a file (write tmp + rename). */
export function writeFileAtomicSync(file: string, data: string): void {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Atomically replace a JSON file (write tmp + rename). */
export function writeJsonAtomicSync(file: string, value: unknown): void {
  writeFileAtomicSync(file, JSON.stringify(value));
}

export function readJsonlSync<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const out: T[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (line.length > 0) out.push(JSON.parse(line) as T);
  }
  return out;
}
