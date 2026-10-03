# press-shop-scheduler

Offline single-machine scheduler for a stamping shop, with exact rational
arithmetic (BigInt, no floats anywhere). Node.js 22, zero dependencies.

## Model

- A task has `id`, `release`, `deadline`, `duration`, `weight`.
- All times are exact rationals `p/q`. JSON input accepts `2`, `"2"`,
  `"3/4"`, or `{ "p": 3, "q": 4" }`. Non-integer JSON numbers are rejected.
- Jobs are non-preemptive and may start at any rational time `t` with
  `release <= t` and `t + duration <= deadline`. Touching boundaries are
  allowed: a job ending at `1` chains with a job released at `1`.
- The solver returns a maximum-weight feasible subset, exact start/end for
  each selected task, and a certificate: for every unselected task, the
  selected tasks whose windows `[release, deadline)` strictly intersect its
  own. Ties on weight resolve to the lexicographically smallest sorted
  selected-id list.

## Exactness and complexity

`1 | r_j, p_j | max sum w_j` is NP-hard. Feasibility of a subset is decided
by the exact subset DP `F(S) = min_j max(F(S\{j}), r_j) + p_j` (kept when
`<= d_j`), so the whole solve costs `O(2^n * n)` time and `O(2^n)` space,
capped at 30 tasks. The test suite cross-checks it against subset x
permutation brute force for `n <= 8`.

## Library

```js
import { Store } from './src/store.js';

const s = new Store();
s.add({ id: 'a', release: '0', deadline: '1', duration: '1/2', weight: '3' });
s.update('a', { weight: '4' });   // validated first; invalid patches write no version
s.remove('a');
s.undo(); s.redo();
s.solve(); // { version, selected: [{id, start, end}], weight, certificate }
```

## CLI

Reads a JSON command sequence from stdin (a JSON array, a single JSON
object, or newline-delimited JSON) and writes one single-line JSON array of
per-command results to stdout.

```sh
echo '[{"op":"add","task":{"id":"a","release":"0","deadline":"1","duration":"1","weight":"2"}},
        {"op":"solve"}]' | node src/cli.js
# [{"ok":true,"version":1},{"ok":true,"version":1,"selected":[{"id":"a","start":"0","end":"1"}],"weight":"2","certificate":{}}]
```

Commands: `add` (`task` object), `update` (`id` + `patch`), `remove` (`id`),
`undo`, `redo`, `solve`, `version`.

## Errors

| condition              | code         |
|------------------------|--------------|
| denominator 0 / float  | `E_RATIONAL` |
| `release > deadline`   | `E_EMPTY`    |
| `duration <= 0`        | `E_EMPTY`    |
| duplicate id           | `E_DUPLICATE`|
| unknown id             | `E_NOT_FOUND`|
| malformed task/command | `E_VALIDATION`|
| unknown op             | `E_UNKNOWN_OP`|

Rejected commands never create a version; the current version is untouched.

## Tests

```sh
node --test
```
