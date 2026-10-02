// Parse a JSONL stream into events. Each non-blank line must be a JSON object
// with a "type" field. Malformed lines become bad_json errors (seq = line
// number) and never stop the rest of the stream.

export function parseStream(text) {
  const events = [];
  const errors = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const seq = i + 1;
    const line = lines[i].trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      errors.push({
        seq,
        event: null,
        id: null,
        error: 'bad_json',
        message: `line ${seq} is not valid JSON`,
      });
      continue;
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.type !== 'string') {
      errors.push({
        seq,
        event: null,
        id: null,
        error: 'invalid_event',
        message: `line ${seq} must be a JSON object with a string "type" field`,
      });
      continue;
    }
    events.push({ seq, type: obj.type, id: obj.id });
  }
  return { events, errors };
}
