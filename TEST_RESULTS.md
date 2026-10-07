# TEST_RESULTS.md

Recorded actual run of `npm test`.

- Date: 2026-10-07
- Node: v22.22.1
- tsc: Version 7.0.2
- Platform: Linux 6.6.114.1-microsoft-standard-WSL2 x86_64

```

> signflip-exact@1.0.0 test
> tsc && node --test dist/test/*.test.js

TAP version 13
# Subtest: dist/test/certificate.test.js
ok 1 - dist/test/certificate.test.js
  ---
  duration_ms: 286.796731
  type: 'test'
  ...
# Subtest: dist/test/confidence.test.js
ok 2 - dist/test/confidence.test.js
  ---
  duration_ms: 278.963158
  type: 'test'
  ...
# Subtest: dist/test/enumerate.test.js
ok 3 - dist/test/enumerate.test.js
  ---
  duration_ms: 573.331423
  type: 'test'
  ...
# Subtest: dist/test/rational.test.js
ok 4 - dist/test/rational.test.js
  ---
  duration_ms: 257.821129
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 4
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 598.063345
```
