'use strict';

const { createHash } = require('node:crypto');

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

// Archive truth: the real checksum of an object's content is derived from its
// id and its parent volume's real checksum (child volumes embed the parent hash).
function contentChecksum(id, parentChecksum = null) {
  return sha256(`${parentChecksum === null ? 'archive' : parentChecksum}|${id}`);
}

module.exports = { sha256, contentChecksum };
