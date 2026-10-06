# fencesim — fencing-token task simulation

C++20 simulation of lease fencing with monotonic tokens.

## Model

- `FenceService` grants strictly monotonic tokens; each grant carries a lease
  that expires at a logical tick (`include/fencesim/fence.hpp`).
- `Storage` accepts a write iff `token >= highest accepted token`. It has no
  reference to the lease service: lease expiry never revokes stored results.
- A stale holder's late write (token below the highest accepted) is rejected;
  every grant and write attempt is recorded as evidence.
- `explore` (`include/fencesim/explore.hpp`) enumerates all bounded fault
  traces — interleavings of holder acquire/write steps with clock ticks that
  can expire leases mid-schedule — and checks the fencing invariant
  (non-decreasing accepted tokens, rejections only below the watermark,
  stored value matches the highest-token write, tokens granted to the writer)
  on every state.

## Build, test, run

```sh
cmake -S . -B build
cmake --build build
ctest --test-dir build --output-on-failure
./build/fencesim_demo   # prints grant/write evidence for a stale-holder fault
```
