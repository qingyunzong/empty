import { createEngine } from './engine.js';
import { parseStream } from './parse.js';

// Run a whole JSONL stream through the engine.
// Returns { state, moves, errors } where errors includes both parse-level
// and engine-level errors, ordered by stream position.
export function runStream(text) {
  const { events, errors: parseErrors } = parseStream(text);
  const engine = createEngine();
  for (const ev of events) engine.handle(ev);
  const { state, moves, errors: engineErrors } = engine.result();
  const errors = [...parseErrors, ...engineErrors].sort((a, b) => a.seq - b.seq);
  return { state, moves, errors };
}
