# quota-freeze-replica

Eventually consistent quota-freeze replica library and CLI. Node.js 22, standard
library only (`node:test` for tests). No dependencies.

## Model

Each replica keeps account limits, frozen amounts, the membership config epoch,
and a causal event log. Every event carries a `requestId`, the authoring
`memberId`, the config `epoch`, a `prev` hash, and a content `hash`
(sha256 over canonical JSON), forming per-member hash chains; membership changes
form a separate config chain.

- `freeze` / `release`: reserve and return quota. Rejected when the author is
  not active (`unknown-member` / `stale-member`) or quota is insufficient
  (`limit-exceeded`).
- `remove-member`: must carry an observation `frontier` equal to the member's
  latest applied event hash, otherwise `remove-incomplete`. Freezes confirmed
  before the frontier stay valid; anything beyond it is `stale-member`.
- Anti-entropy: `diff` reports missing freeze/release/member event ids between
  two state summaries; `merge` applies missing events in causal order and
  reports per-event rejections.

## CLI

State lives in a JSON file (`--state <file>`, env `REPLICA_STATE`, or
`replica-state.json`). All output is JSON; errors print `{"error":"code"}` and
exit 1.

```sh
node cli.js account acct --limit 1000 --state a.json   # create/configure + query
node cli.js add-member --member m1 --state a.json
node cli.js freeze --account acct --amount 200 --member m1 --request-id f1 --state a.json
node cli.js release --member m1 --target f1 --request-id r1 --state a.json
node cli.js remove-member --member m1 [--frontier <hash>] --state a.json
node cli.js diff b.json --state a.json                 # missing event ids
node cli.js merge b.json --state a.json                # apply missing events
```

## Tests

```sh
node --test --test-reporter spec > result.txt 2>&1; echo $? >> result.txt
```
