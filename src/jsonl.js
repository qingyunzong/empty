export class JsonlError extends Error {
  constructor(line, message) {
    super(`line ${line}: ${message}`);
    this.line = line;
  }
}

export function parseJsonl(text) {
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (raw === '') continue;
    try {
      records.push(JSON.parse(raw));
    } catch (err) {
      throw new JsonlError(i + 1, err.message);
    }
  }
  return records;
}

export function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}
