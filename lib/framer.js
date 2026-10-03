'use strict';

class FrameError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FrameError';
  }
}

// Newline-delimited JSON frame parser. Handles sticky packets (several
// frames in one chunk) and half packets (one frame split across chunks).
class Framer {
  constructor() {
    this.buf = '';
  }

  // Push a chunk (string or Buffer); returns an array of parsed frames.
  // Throws FrameError on malformed JSON.
  push(chunk) {
    this.buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    const frames = [];
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let frame;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        throw new FrameError('invalid JSON frame: ' + trimmed.slice(0, 80));
      }
      frames.push(frame);
    }
    return frames;
  }

  // Call at end of stream. Throws FrameError if a partial frame remains.
  end() {
    if (this.buf.trim() !== '') {
      throw new FrameError('truncated trailing frame: ' + this.buf.trim().slice(0, 80));
    }
    this.buf = '';
  }
}

module.exports = { Framer, FrameError };
