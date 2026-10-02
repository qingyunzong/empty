// Crash-injection fixture: commits three corrections with index flushing
// disabled, then dies without close()/flush(). The WAL is fsynced on every
// commit, so all records must survive; the on-disk indexes must not exist.
import { openStore } from '../src/store.js';

const dir = process.argv[2];
const store = openStore(dir, { flushEvery: Number.POSITIVE_INFINITY });
store.commit({ id: 'A', target: 'CRASH-T', value: 'v1', t: 1 });
store.commit({ id: 'B', value: 'v2', corrects: 'A', t: 2 });
store.commit({ id: 'C', value: 'v3', corrects: 'B', t: 3 });
process.exit(1); // simulated crash: no flush, no close
