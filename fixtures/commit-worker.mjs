// Worker: acts as one analyzer process committing to a shared repo dir.
import { parentPort, workerData } from 'node:worker_threads';
import { Repo } from '../src/store.js';
import { commit } from '../src/commit.js';

const { dir, batch } = workerData;
const repo = new Repo(dir);
try {
  const r = commit(repo, batch);
  parentPort.postMessage({ ok: true, result: r });
} catch (e) {
  parentPort.postMessage({ ok: false, code: e.code, message: e.message });
}
