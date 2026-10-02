# RESULTS

Command: `node --test` (Node.js v22.22.1, standard library only, offline).

Latest run: **6/6 test files pass, 27/27 subtests pass, 0 fail**
(~25 s total; the fuzz file dominates runtime).

| File | Subtests | Result |
| --- | --- | --- |
| test/cli.test.js | 3 | pass |
| test/dsl.test.js | 6 | pass |
| test/errors.test.js | 6 | pass |
| test/fuzz.test.js | 1 (12 random seeds × 30 obligations) | pass |
| test/netting.test.js | 4 | pass |
| test/typecheck.test.js | 7 | pass |

## Acceptance criteria mapping

1. **5-member manual ring reproducible** — `test/netting.test.js`
   "acceptance 1": ring M1→…→M5→M1 of 25000 each plus M1→M3 10000 yields
   exactly one solution: cycle `[M1,M2,M3,M4,M5]` @25000 cancelled, residual
   cash 10000 (M1→M3), positions `{M1:-10000, M3:+10000}`.
2. **Tied optima both listed** — `test/netting.test.js` "acceptance 2":
   complete 3-member graph (all pairs 10000) yields exactly two optimal
   solutions (`{MA↔MB, MA↔MC, MB↔MC}` and `{MA→MB→MC→MA, MA→MC→MB→MA}`),
   deterministically ordered; two runs produce deep-equal output.
3. **Mixed currency / cross-date constant errors** — `test/typecheck.test.js`:
   `100 USD + 200 EUR` → `E_CCY`; `amount + 1 EUR > 2 USD` → `E_CCY`;
   `2026-10-01.cap` referenced from the 2026-10-02 scope → `E_SCOPE`;
   net-as-gross / gross-as-net → `E_TYPE`.
4. **Random 30 obligations vs brute-force reference** — `test/fuzz.test.js`:
   12 seeded runs; engine minimum cash equals the independent DFS reference
   (`src/reference.js`), the full sets of tied optima match, and every
   solution preserves every member's net position (also re-verified by
   `verifySolution` inside the engine on every run).

## Reproduce

```sh
node --test                 # full suite
node net.js run rules.net obs.json --proof proof.json   # CLI demo
```
