'use strict';

class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
    this.code = 'FRAME_ERROR';
  }
}

function parseFrame(line) {
  try {
    return JSON.parse(line);
  } catch (err) {
    throw new FrameError(`invalid JSON frame: ${err.message}`);
  }
}

// Newline-delimited JSON frame parser. Handles sticky packets (multiple
// frames per chunk) and half packets (a frame split across chunks).
class FrameParser {
  constructor() {
    this.buffer = '';
  }

  push(chunk) {
    this.buffer += chunk;
    const frames = [];
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim() === '') continue;
      frames.push(parseFrame(line));
    }
    return frames;
  }

  end() {
    const rest = this.buffer;
    this.buffer = '';
    if (rest.trim() === '') return [];
    return [parseFrame(rest)];
  }
}

module.exports = { FrameParser, FrameError, parseFrame };
