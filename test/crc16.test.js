'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crc16 } = require('../lib/crc16');

test('crc16 CCITT-FALSE known vector', () => {
  assert.equal(crc16(Buffer.from('123456789', 'ascii')), 0x29b1);
  assert.equal(crc16(Buffer.alloc(0)), 0xffff);
});
