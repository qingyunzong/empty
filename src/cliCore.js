import { Engine } from './engine.js';

// Feed newline-delimited JSON commands through an engine, return the output
// objects (one per non-empty input line). Shared by bin/cli.js and tests.
export function runLines(text, engine = new Engine()) {
  const out = [];
  for (const line of text.split('\n')) {
    const res = engine.handleLine(line);
    if (res !== null && res !== undefined) out.push(res);
  }
  return out;
}
