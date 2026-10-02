'use strict';

const { LinkSession } = require('./link');
const { Engine } = require('./engine');

// Glues the link layer to the business engine:
//  - retransmissions (link-level duplicates) replay the cached reply
//  - frames already present in a recovered log are answered from the log
//  - everything else is processed by the engine
class Gateway {
  constructor(opts = {}) {
    this.link = new LinkSession();
    this.engine = opts.engine || new Engine(opts);
    this.cache = new Map(); // `${member}#${seq}` -> reply
  }

  handleFrame(frame) {
    const out = [];
    for (const delivery of this.link.ingest(frame)) {
      const key = `${delivery.frame.member}#${delivery.frame.seq}`;
      if (delivery.duplicate) {
        const cached = this.cache.get(key) || this.engine.recoveredReplies.get(key);
        if (cached) out.push({ ...cached, dup: true });
        continue;
      }
      const recovered = this.engine.recoveredReplies.get(key);
      if (recovered) {
        out.push({ ...recovered, recovered: true });
        continue;
      }
      const reply = this.engine.process(delivery.frame);
      this.cache.set(key, reply);
      out.push(reply);
    }
    return out;
  }
}

module.exports = { Gateway };
