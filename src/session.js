import { Store } from './store.js';

// Pure request handler shared by the CLI and tests: applies the initial task
// load, then each transaction in order against the same store.
export function processRequest(request) {
  const store = new Store();
  const loaded = store.loadTasks(request.tasks ?? []);
  if (!loaded.ok) return loaded;
  const transactions = request.transactions ?? (request.ops ? [request] : []);
  return { ok: true, results: transactions.map((tx) => store.applyTransaction(tx)) };
}

// Parse one JSON request string (as read from stdin) and produce the response.
export function runRequest(input) {
  let request;
  try {
    request = JSON.parse(input);
  } catch (error) {
    return { ok: false, error: { code: 'E_PARSE', message: String(error?.message ?? error) } };
  }
  try {
    return processRequest(request);
  } catch (error) {
    return { ok: false, error: { code: 'E_INTERNAL', message: String(error?.message ?? error) } };
  }
}
