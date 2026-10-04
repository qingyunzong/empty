'use strict';

// Extracts complete JSON objects from a text buffer. Tolerates frames that
// were fragmented / concatenated in transit: anything between top-level
// balanced {...} regions is ignored, so both normal JSONL and reassembled
// fragments work.
function extractFrames(text) {
  const frames = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          frames.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return frames;
}

function parseEvents(text) {
  const frames = extractFrames(text);
  const events = [];
  for (const frame of frames) {
    events.push(JSON.parse(frame));
  }
  return events;
}

module.exports = { extractFrames, parseEvents };
