# limit

Pre-authorization credit limit library and CLI. Node.js 22, standard library only.

Accounts track `creditLimit`, `frozen`, `used`. Authorizations:

- `freeze(authId, acc, amount, ttl, now)` — reserve credit; fails with `E_LIMIT`
  if `amount > creditLimit - frozen - used`, `E_STATE` on duplicate authId.
- `capture(authId, amount, now)` — move frozen -> used; multiple partial captures
  per auth allowed; `E_LIMIT` if `amount` exceeds the remaining frozen amount.
- `release(authId, now)` — release the remaining frozen amount.
- `extend(authId, ttl, now)` — set `expiresAt = now + ttl`.

Expiry: an auth frozen at `t0` with `ttl` is valid for `t < t0 + ttl` and expires
at exactly `t0 + ttl`. Expiry is applied lazily at each op's event time and via
`scan(now)`; both produce identical state. Expired-but-uncaptured auths release
their remaining frozen amount automatically; touching an expired auth fails with
`E_EXPIRED`. Failed ops never mutate `frozen`/`used`.

Linearizability: `checkLinearizable(log)` (see `src/linearize.js`) decides whether
a concurrent interleaved log with recorded results can be ordered into a legal
serial history and returns a witness permutation.

## Usage

```
node bin/limit.js run ops.jsonl --explain
node bin/limit.js check log.jsonl
node --test
```

See `RESULTS.md` for the op format and test summary.
