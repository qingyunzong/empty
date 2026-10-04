# route-lib

Offline process-routing library and CLI. Node.js 22, standard library only.

## Layout

- `src/crc32.js` — CRC32 (IEEE) checksums.
- `src/graph.js` — in-memory graph model (nodes, directed edges, device load) and change application.
- `src/codec.js` — chunked graph encoding; every chunk carries a CRC32 and the header index maps each node id to its `[chunk, byteOffset]`. `decodeIncremental` builds the graph chunk by chunk; on corruption it stops and the decoded prefix stays queryable.
- `src/store.js` — versioned store. Commits carry a base version and a read set; if any read-set entry was written between base and HEAD the commit is rejected with `E_CONFLICT` and a deterministic certificate (both version hashes, read set, common ancestor). No auto-merge.
- `src/router.js` — optimal route: simple paths with strictly increasing operation index (precedence) that fit device daily capacity; minimal total processing time, ties broken by lexicographic node sequence. `E_CYCLE` on cycles, `E_CAPACITY` when every route exceeds capacity.
- `cli.js` — `init | commit | route | show | log`; also importable as `runCli(argv)`.

## CLI

```sh
node cli.js init --store .store
node cli.js commit --store .store --base <hash> --read s,m \
  --change '{"addNodes":[{"id":"s","op":0,"device":"A","time":5}],"addEdges":[["s","t"]],"occupy":{"A":10}}'
node cli.js route --store .store --from s --to t --capacity '{"A":100}'
node cli.js show --store .store [--version <hash>]
node cli.js log --store .store
```

Exit codes: 0 ok, 2 `E_CONFLICT`, 3 `E_CYCLE`, 4 `E_CAPACITY`, 5 `E_CORRUPT`,
6 `E_NO_PATH`, 7 `E_NOT_FOUND`, 8 `E_INVALID`.

## Tests

```sh
node --test
```
