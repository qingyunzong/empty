# order-event-store

Offline, single-node order event stream store built on the Node.js 22 standard
library only. Events carry `id`, `tradeId`, `fee`, `refundBudget`, `text` and
`state`.

## Features

- Positional inverted index over `text` with phrase queries and unordered
  near (proximity) queries.
- Tombstone deletes; when a segment's liveness drops below
  `mergeThreshold` (default 0.5) the store merges and compacts segments.
  Old segments stay on disk until the new manifest is committed, so queries
  during a merge see a consistent view on either old or new segments.
- Crash-safe commits: the manifest is written to `manifest.json.tmp`,
  fsynced, then atomically renamed to `manifest.json`. If the manifest is
  missing or half-written, the store falls back to `manifest.json.bak`
  (old segments), then to scanning segment files.
- `undoTrade(tradeId)` refunds all fees of a trade in one shot, limited by
  the trade's `refundBudget`. If the budget is insufficient nothing is
  refunded and the state is untouched (`ERR_BUDGET_EXCEEDED`). Unknown
  trades return `ERR_UNKNOWN_TRADE`.

## Library

```js
import { Store } from './src/store.js';

const store = Store.open('./data', { mergeThreshold: 0.5 });
store.append({ id: 'e1', tradeId: 't1', fee: 10, refundBudget: 100, text: 'new york', state: 'open' });
store.queryPhrase('new york');        // => ['e1']
store.queryNear(['york', 'new'], 3);  // unordered near, window 3
store.delete('e1');                   // tombstone
store.undoTrade('t1');                // => { tradeId, refunded, budgetRemaining }
store.merge();                        // manual compaction
```

## CLI

```
node bin/cli.js --dir ./data append '{"id":"e1","tradeId":"t1","fee":10,"refundBudget":100,"text":"new york","state":"open"}'
node bin/cli.js --dir ./data phrase "new york"
node bin/cli.js --dir ./data near new york --window 3
node bin/cli.js --dir ./data delete e1
node bin/cli.js --dir ./data undo t1
node bin/cli.js --dir ./data merge
node bin/cli.js --dir ./data stats
```

Errors print `<CODE>: <message>` on stderr and exit with code 1.

## Tests

```
node --test
```
