# shift-archive

Cross-shift device event archive. Node.js 22, standard library only, offline.

## Model

- Events: `{ ts, device, seq, tokens }`; tokens are normalized (lowercase,
  split on non-alphanumerics). Appends must have non-decreasing `ts`.
- Each device's events form one global token stream with absolute positions.
- **Active layer**: writable segment (`active/events.jsonl`) with an exact
  in-memory index.
- **Frozen layer**: segments of 16-event blocks, deflate + varint/delta
  compressed, with a per-device token postings index carrying skip pointers
  (`src/postings.js`). A shared dictionary (`dict.json`) only ever grows, so
  old frozen segments stay decodable after dictionary updates.
- **Retention**: `retain` writes time-window tombstones
  (`--before ts` deletes `ts < before`, `--until ts` deletes `ts <= until`);
  tombstoned events keep their positions but break the token stream.
- **Merge**: `merge --from --to` replaces a contiguous window of frozen
  segments. The new segment is staged under `tmp/` and committed by a single
  atomic manifest rename; a crash before the commit leaves the old window
  fully usable.

## Queries

- `--phrase "a b c"`: token subsequence; may span events and segment
  boundaries.
- `--near a b --k n`: tokens within position distance `n`; cross-segment
  hits are reported.
- Results are sorted by `(ts, device, seq, pos)`.

## CLI

```
node bin/cli.js append --archive DIR --device D --ts T --text "..."
node bin/cli.js freeze --archive DIR
node bin/cli.js merge  --archive DIR --from T --to T
node bin/cli.js retain --archive DIR --before T | --until T
node bin/cli.js query  --archive DIR --phrase "..." | --near A B --k N
node bin/cli.js stats  --archive DIR
```

Errors exit 1 with `E_WINDOW` (invalid window/input), `E_MERGE` (merge
failure), `E_RETAIN` (retain failure).

## Tests

```
node --test
```

- `test/encoding.test.js`: varint/delta/postings skip-list roundtrips.
- `test/acceptance.test.js`:
  1. Exhaustive small event streams x all freeze-window patterns; phrase and
     near (incl. cross-segment) compared against a brute-force reference.
  2. Merge killed mid-way (staged, pre-commit): old window still usable;
     a later real merge preserves query results.
  3. Retain boundary equality: `ts == --before` kept, `ts == --until` removed.
  4. Dictionary grows after old segments are frozen: old segments still
     decode, cross-dict-version phrase still hits.
