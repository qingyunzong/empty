"use strict";

const fs = require("node:fs");
const { chainHash } = require("./util");

// Append-only op journal with a SHA-256 hash chain. Each line is
// {"seq":n,"prev":<hash>,"hash":<hash>,"op":{...}}. Recovery replays valid
// lines, verifies the chain, and truncates a torn/corrupt tail so a crash
// mid-write never causes an op (and its budget charge) to be applied twice.
class Journal {
  constructor(path) {
    this.path = path;
    this.fd = null;
  }

  open() {
    if (this.fd === null) this.fd = fs.openSync(this.path, "a");
  }

  append(entry) {
    this.open();
    fs.writeSync(this.fd, JSON.stringify(entry) + "\n");
    fs.fsyncSync(this.fd);
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  recoverInto(engine) {
    const result = { recovered: 0, truncated: false };
    if (!fs.existsSync(this.path)) return result;
    const buf = fs.readFileSync(this.path);
    let offset = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      if (nl === -1) {
        // Torn tail: last line was never fully written.
        result.truncated = true;
        break;
      }
      const line = buf.toString("utf8", offset, nl);
      let entry = null;
      try {
        entry = JSON.parse(line);
      } catch {
        result.truncated = true;
        break;
      }
      const expectedHash = chainHash(engine.prevHash, entry.op);
      if (
        entry.seq !== engine.seq + 1 ||
        entry.prev !== engine.prevHash ||
        entry.hash !== expectedHash
      ) {
        result.truncated = true;
        break;
      }
      engine.applyOp(entry.op, { fromJournal: true });
      result.recovered += 1;
      offset = nl + 1;
    }
    if (result.truncated) fs.truncateSync(this.path, offset);
    return result;
  }
}

module.exports = { Journal };
