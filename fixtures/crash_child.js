'use strict';

// Child process for the kill -9 acceptance test.
// Commits ops A (fully durable), then arms the fault-point hook and starts
// op B: the segment write lands, then SIGKILL fires before the index write.
const { Store } = require('../src/store');

const dir = process.argv[2];
const store = Store.open(dir);

store.addLot({ id: 'A', kind: 'raw', qty: 100, status: 'quarantine' });
store.addLot({ id: 'B', kind: 'finished', qty: 50, status: 'in_stock' });
store.addEdge({ id: 'e1', from: 'A', to: 'B', kind: 'split', qty: 50, ratio: 0.5, time: 1 });

process.env.WAL_CRASH_AFTER_SEGMENT = '1';
store.addLot({ id: 'C', kind: 'finished', qty: 10, status: 'in_stock' }); // never returns
console.log('UNREACHABLE');
