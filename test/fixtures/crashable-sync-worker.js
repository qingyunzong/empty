import { parentPort, workerData } from 'node:worker_threads';
import { sync } from '../../lib/engine.js';

// Runs sync and blocks forever right after the journal is fsynced but before
// the checkpoint is written, so the parent can terminate() (kill) the worker
// at exactly the crash window.
sync({
  ...workerData,
  hooks: {
    afterJournal: () => {
      parentPort.postMessage('journal-durable');
      while (true) {}
    },
  },
});
parentPort.postMessage('completed');
