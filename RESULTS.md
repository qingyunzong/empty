# RESULTS

Recorded from a real run on 2026-10-02, Node v22.22.1 (Linux x64),
command: `node --test` (working tree at the time of the run).

## Summary

```
# tests 3
# pass 3
# fail 0
# duration_ms 6132.184852
```

3 test files, 17 individual tests, all passing.

## Per-test results

`node test/audit.test.js`:

```
ok 1 - acceptance 1: estimated reading replaced by actual lowers the peak
ok 2 - acceptance 2: tariff retraction recomputes cost and changes the optimal shed plan
ok 3 - shed retraction is forbidden: shed stays, compensation record appended
ok 4 - watermark = max event time - 1 minute; out-of-order events go to late.log
ok 5 - malformed lines and unknown retracts are logged, not fatal
ok 6 - multiple meters sum into the same window
```

`node test/cli.test.js`:

```
ok 1 - acceptance 4a: kwh rollback without retraction aborts with METER_ROLLBACK (lib)
ok 2 - acceptance 4b: negative first kwh reading is a rollback against the zero baseline
ok 3 - acceptance 4c: rollback corrected by retraction is accepted
ok 4 - acceptance 4d: CLI exits 1 and reports METER_ROLLBACK on stderr
ok 5 - CLI audit writes windows.jsonl, settlement.json, comp.jsonl, late.log
ok 6 - CLI rejects bad usage with exit code 2
```

`node test/optimize.test.js`:

```
ok 1 - acceptance 3a: tied optimal plans are all reported, load-lexicographic order
ok 2 - acceptance 3b: <=3 windows exhaustive result matches independent brute force
ok 3 - budget caps sheddable kW per window
ok 4 - zero rate window never gets shed
ok 5 - empty input yields a trivial empty plan
```

## Acceptance mapping

1. **估计改实测降低峰值** — `test/audit.test.js` "acceptance 1": estimated
   60 kWh window (240 kW) corrected to 30 kWh (120 kW) after
   `retract(meter, estimate)` + actual reading.
2. **费率撤回改变最优切法** — `test/audit.test.js` "acceptance 2": flat-rate
   optimum `[A@w0, B@w0, B@w1]` (cost 700) becomes `[A@w1, B@w1]` (cost 6000)
   after the tariff is retracted and replaced; executed shed plan unchanged.
3. **枚举<=3窗穷举对照并列** — `test/optimize.test.js` "acceptance 3a/3b":
   tied plans (`{A}` vs `{B}`) both reported in load-lexicographic order;
   3-window exhaustive result cross-checked against an independent
   brute-force reference in the test.
4. **负 kwh 边界** — `test/cli.test.js` "acceptance 4a–4d": rollback without
   retraction and negative first reading both abort with `METER_ROLLBACK`
   (CLI exit 1, stderr message); a retracted rollback is accepted.

## CLI smoke run

`node bin/demand.js audit --in /tmp/smoke/in --out /tmp/smoke/out` on an
8-event stream (estimate retracted by actual, shed retracted):

```
audited 2 windows; peak 120 kW @ 2026-01-05T00:00:00.000Z; optimal cost 1500 (exhaustive, 1 plan(s)); executed cost 1500; executedIsOptimal=true
exit=0
```

Outputs verified: `windows.jsonl` (2 rows, corrected kwh 30/25),
`settlement.json` (`executedIsOptimal: true`), `comp.jsonl` (1 record,
`SHED_RETRACT_FORBIDDEN`), `late.log` (empty).
