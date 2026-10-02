'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { crc32c } = require('../src/crc32c');

test('crc32c known vectors', () => {
  assert.equal(crc32c(Buffer.alloc(0)), 0x00000000);
  assert.equal(crc32c(Buffer.from('123456789', 'ascii')), 0xe3069283);
  assert.equal(crc32c(Buffer.from('hello world', 'ascii')), 0xc99465aa);
  assert.equal(crc32c(Buffer.alloc(32, 0xff)), 0x62a8ab43);
});
