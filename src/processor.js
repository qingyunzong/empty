'use strict';

const { Framer } = require('./framer');
const { Gateway, ProtocolViolation } = require('./gateway');

// Incremental stream processor: push arbitrary byte chunks, get NDJSON-event
// objects back. The virtual clock advances one tick per consumed byte, so
// results are independent of chunking (sticky / half frames included).
class Processor {
  constructor({ timeout = 0, maxRetries = 3 } = {}) {
    this.framer = new Framer();
    this.gateway = new Gateway({ timeout, maxRetries });
    this.tick = 0;
    this.failed = null; // latched { error, exitCode }
  }

  // Returns { events, error? }. After an error the processor is latched and
  // ignores further input.
  push(chunk) {
    if (this.failed) return { events: [], error: this.failed.error };
    const events = [];
    for (let i = 0; i < chunk.length; i++) {
      this.tick++;
      const { frames, error } = this.framer.push(chunk.subarray(i, i + 1));
      if (error) return this.fail(events, error, 2);
      for (const frame of frames) {
        try {
          events.push(...this.gateway.handleFrame(frame, this.tick));
        } catch (err) {
          if (err instanceof ProtocolViolation) {
            return this.fail(events, { code: err.code, offset: err.offset }, 3);
          }
          throw err;
        }
      }
      events.push(...this.gateway.checkTimeout(this.tick));
    }
    return { events, error: null };
  }

  // Returns { events, certificate?, error? }.
  finish() {
    if (this.failed) return { events: [], error: this.failed.error };
    const events = [];
    const frameError = this.framer.finish();
    if (frameError) return this.fail(events, frameError, 2);
    const gapError = this.gateway.finish(this.tick);
    if (gapError) return this.fail(events, gapError, 3);
    return { events, certificate: this.gateway.certificate(this.tick), error: null };
  }

  fail(events, error, exitCode) {
    this.failed = { error, exitCode };
    return { events, error, exitCode };
  }
}

// One-shot helper: process a whole buffer.
function processBytes(bytes, opts = {}) {
  const processor = new Processor(opts);
  const events = [];
  const pushed = processor.push(bytes);
  events.push(...pushed.events);
  if (pushed.error) return { events, error: pushed.error, exitCode: pushed.exitCode };
  const done = processor.finish();
  events.push(...done.events);
  if (done.error) return { events, error: done.error, exitCode: done.exitCode };
  return { events, certificate: done.certificate, error: null, exitCode: 0 };
}

module.exports = { Processor, processBytes };
