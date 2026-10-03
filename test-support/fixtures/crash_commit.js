'use strict';

// Child-process helper: commits one good transaction, then starts a second
// commit that is killed (via KVSTORE_FAULT=afterDataFsync) after the WAL data
// record is fsynced but before the commit marker is written.

const { Store } = require('../../src/store');

const dir = process.argv[2];
// Disarm the inherited fault point so the first commit lands completely;
// it is re-armed below, right before the doomed commit.
delete process.env.KVSTORE_FAULT;
const store = new Store(dir);

const committed = store.begin();
committed.put('stable-key', 'stable-value');
committed.commit();

// Arm the fault point only now, so the first commit lands completely.
process.env.KVSTORE_FAULT = 'afterDataFsync';

const doomed = store.begin();
doomed.put('doomed-key', 'doomed-value');
doomed.commit(); // process exits here when KVSTORE_FAULT=afterDataFsync

console.log('unreachable');
