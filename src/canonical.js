'use strict';

const { toMs } = require('./writer');

// Canonical JSON enumeration of a tag: fixed (alphabetical) key order,
// time rendered as an ISO-8601 UTC string.
function canonicalLine(tag) {
  return JSON.stringify({
    batch: String(tag.batch),
    gtin: String(tag.gtin),
    serial: String(tag.serial),
    station: String(tag.station),
    time: new Date(toMs(tag.time)).toISOString(),
  });
}

module.exports = { canonicalLine };
