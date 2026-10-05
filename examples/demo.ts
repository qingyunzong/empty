import {
  compress,
  decompress,
  serializeStream,
  summarize,
  type StreamEvent,
} from '../src/event-compressor.js';

const events: StreamEvent[] = [
  { kind: 'put', id: 'e1', key: 'alpha', version: 1, data: Buffer.from('aa') },
  { kind: 'put', id: 'e2', key: 'alpha', version: 2, data: Buffer.from('bb') },
  { kind: 'put', id: 'e3', key: 'alpha', version: 3, data: Buffer.from('cc') },
  { kind: 'barrier', id: 'B1' },
  { kind: 'put', id: 'e4', key: 'alpha', version: 4, data: Buffer.from('dd') },
  { kind: 'put', id: 'e5', key: 'beta', version: 1, data: Buffer.from('zz') },
];

const records = compress(events);
console.log('compressed summary:');
for (const line of summarize(records)) console.log('  ' + line);

const restored = decompress(records);
const identical = serializeStream(restored).equals(serializeStream(events));
console.log(`round-trip byte sequence identical: ${identical}`);
