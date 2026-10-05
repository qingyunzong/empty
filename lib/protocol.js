'use strict';

const fs = require('node:fs');

class ProtocolError extends Error {
  constructor(code, message, exitCode = 2) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

function loadProtocol(file) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new ProtocolError('BAD_PROTOCOL', `cannot read protocol ${file}: ${err.message}`, 1);
  }
  return compileProtocol(raw);
}

function compileProtocol(raw) {
  if (!raw || !Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new ProtocolError('BAD_PROTOCOL', 'protocol.steps must be a non-empty array', 1);
  }
  const steps = raw.steps.map((s) => ({
    id: s.id,
    kind: s.kind || 'generic',
    requires: Array.isArray(s.requires) ? s.requires : [],
    produces: Array.isArray(s.produces) ? s.produces : [],
    timeout: s.timeout == null ? null : Number(s.timeout),
  }));
  const byId = new Map();
  for (const s of steps) {
    if (!s.id) throw new ProtocolError('BAD_PROTOCOL', 'every step needs an id', 1);
    if (byId.has(s.id)) throw new ProtocolError('BAD_PROTOCOL', `duplicate step id ${s.id}`, 1);
    if (s.timeout != null && !(s.timeout >= 0)) {
      throw new ProtocolError('BAD_PROTOCOL', `step ${s.id} has invalid timeout`, 1);
    }
    byId.set(s.id, s);
  }
  const producers = new Map();
  for (const s of steps) {
    for (const p of s.produces) {
      if (producers.has(p)) {
        throw new ProtocolError('BAD_PROTOCOL', `product ${p} produced by multiple steps`, 1);
      }
      producers.set(p, s.id);
    }
  }
  for (const s of steps) {
    for (const r of s.requires) {
      if (!producers.has(r)) {
        throw new ProtocolError(
          'MISSING_PRODUCT',
          `step ${s.id} requires ${r} but no step produces it`,
          2,
        );
      }
    }
  }
  const consumers = new Map();
  for (const s of steps) {
    for (const r of s.requires) {
      if (!consumers.has(r)) consumers.set(r, []);
      consumers.get(r).push(s.id);
    }
  }
  function transitiveUpstream(id) {
    const out = [];
    const seen = new Set();
    (function visit(sid) {
      for (const r of byId.get(sid).requires) {
        const prod = producers.get(r);
        if (prod && !seen.has(prod)) {
          seen.add(prod);
          visit(prod);
          out.push(prod);
        }
      }
    })(id);
    return out; // producers-first topological order
  }
  function transitiveDownstream(id) {
    const out = [];
    const seen = new Set();
    (function visit(sid) {
      for (const p of byId.get(sid).produces) {
        for (const c of consumers.get(p) || []) {
          if (!seen.has(c)) {
            seen.add(c);
            out.push(c);
            visit(c);
          }
        }
      }
    })(id);
    return out;
  }
  return {
    name: raw.name || raw.protocol || 'unnamed',
    steps,
    byId,
    producers,
    consumers,
    transitiveUpstream,
    transitiveDownstream,
  };
}

module.exports = { loadProtocol, compileProtocol, ProtocolError };
