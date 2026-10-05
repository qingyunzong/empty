'use strict';

const crypto = require('node:crypto');

const WINDOW_MS = 5 * 60 * 1000; // 5-minute tumbling windows
const RULES_VERSION = 'settle-v1';

function windowOf(ts) {
  return Math.floor(ts / WINDOW_MS) * WINDOW_MS;
}

// Returns null when valid, otherwise a data-error code.
function validateEvent(ev) {
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) return 'DATA_ERROR';
  if (ev.type !== 'auth' && ev.type !== 'capture' && ev.type !== 'void') return 'DATA_ERROR';
  if (typeof ev.id !== 'string' || ev.id.length === 0) return 'DATA_ERROR';
  if (typeof ev.ts !== 'number' || !Number.isFinite(ev.ts) || ev.ts < 0) return 'DATA_ERROR';
  if (ev.type === 'void') return null; // void carries id+ts; amt/mch come from the original entry
  if (typeof ev.mch !== 'string' || ev.mch.length === 0) return 'DATA_ERROR';
  if (!Number.isInteger(ev.amt) || ev.amt < 0) return 'DATA_ERROR'; // integer cents, non-negative
  return null;
}

// Canonical, arrival-order-independent form of the entries contributing to a window.
function canonicalEntries(entries) {
  return entries
    .map((e) => ({ id: e.id, type: e.type, amt: e.amt, ts: e.ts }))
    .sort((a, b) =>
      a.ts - b.ts ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)
    );
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// cert = sha256(canonical input + rules version)
function windowCert(winStart, winEnd, mch, entries) {
  const payload = JSON.stringify({
    v: RULES_VERSION,
    kind: 'final',
    winStart,
    winEnd,
    mch,
    entries: canonicalEntries(entries),
  });
  return sha256(payload);
}

function correctionCert(winStart, winEnd, mch, voidEvent, amt) {
  const payload = JSON.stringify({
    v: RULES_VERSION,
    kind: 'correction',
    winStart,
    winEnd,
    mch,
    voidId: voidEvent.id,
    voidTs: voidEvent.ts,
    amt,
  });
  return sha256(payload);
}

module.exports = {
  WINDOW_MS,
  RULES_VERSION,
  windowOf,
  validateEvent,
  canonicalEntries,
  windowCert,
  correctionCert,
};
