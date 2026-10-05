# voucher-index

Persistent positional index for merchant settlement vouchers (JSONL records with
`id`, `merchant`, `amount`, `tags`, `text`, `status`). Node.js 22 standard library
only; fully offline.

## Library

```js
import { VoucherStore } from './src/index.js';

const store = VoucherStore.build(dir, records);   // or VoucherStore.open(dir)
store.addRecords(records);                        // incremental, versioned
store.revoke(id); store.restore(id);              // tombstones, survive restart
const { matches, certificate } = store.phraseQuery('quick brown', { slop: 1 });
```

- Positions are delta + varint (LEB128) compressed binary blocks, base64 inside
  the segment — never raw JSON arrays (`src/codec.js`).
- Updates write `index.json.tmp` + `commit.json`, then atomically rename. On
  open, a temp segment without a commit marker is discarded (old index kept);
  a committed-but-unrenamed segment is completed.
- `certificate` = `{ indexVersion, query, liveRecordsSha256 }` (SHA-256 over the
  canonical live-record set).
- Errors throw `StoreError` with `code`: `UNKNOWN_ID`, `INVALID_SLOP`,
  `CORRUPT_JSON`, `INVALID_RECORD`, `INVALID_QUERY`, `NO_INDEX`, `USAGE`, `IO_ERROR`.

## CLI

```
node bin/cli.js build   --dir D --file data.jsonl
node bin/cli.js add     --dir D --file more.jsonl
node bin/cli.js query   --dir D --phrase "quick brown" [--slop 1]
node bin/cli.js revoke  --dir D --id a1
node bin/cli.js restore --dir D --id a1
```

Success prints result JSON on stdout (exit 0). Failures print
`{"error": "...", "code": "..."}` on stderr and exit 1 without mutating state.

## Tests

```
node --test
```
