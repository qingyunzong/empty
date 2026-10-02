import { parentPort, workerData } from 'node:worker_threads';
import { checkSlice } from './perm-core.mjs';

const checked = checkSlice(workerData.eventCount, workerData.workerId, workerData.numWorkers);
parentPort.postMessage({ checked });
