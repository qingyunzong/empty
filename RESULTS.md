# RESULTS

Environment: Node.js v22.22.1, `node --test` run at the repository root.

## `node --test`

Exit code: 0

```
TAP version 13
# Subtest: test/budget.test.js
ok 1 - test/budget.test.js
  ---
  duration_ms: 1671.250428
  type: 'test'
  ...
# Subtest: test/cli.test.js
ok 2 - test/cli.test.js
  ---
  duration_ms: 16026.23273
  type: 'test'
  ...
# Subtest: test/constraints.test.js
ok 3 - test/constraints.test.js
  ---
  duration_ms: 2404.75931
  type: 'test'
  ...
# Subtest: test/correction.test.js
ok 4 - test/correction.test.js
  ---
  duration_ms: 1755.669047
  type: 'test'
  ...
# Subtest: test/enumerator.test.js
ok 5 - test/enumerator.test.js
  ---
  duration_ms: 5546.775302
  type: 'test'
  ...
# Subtest: test/undo.test.js
ok 6 - test/undo.test.js
  ---
  duration_ms: 1853.586832
  type: 'test'
  ...
1..6
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 16593.259559
```

## CLI demos

### Chained reassignment after a correction (exit 0)

Input (`demo.jsonl`): two observations per star for B/C/D, one for A;
`correct_obs` moves A onto B's cell, forcing B→C→D to shift.

```jsonl
{"type":"config","coordBins":6,"magBins":1,"capacity":4}
{"type":"add_obs","id":"a1","star":"A","night":1,"ts":1,"coord":1,"mag":0,"conf":0.9}
{"type":"add_obs","id":"b1","star":"B","night":1,"ts":1,"coord":2,"mag":0,"conf":0.9}
{"type":"add_obs","id":"b2","star":"B","night":1,"ts":2,"coord":3,"mag":0,"conf":0.8}
{"type":"add_obs","id":"c1","star":"C","night":1,"ts":1,"coord":3,"mag":0,"conf":0.9}
{"type":"add_obs","id":"c2","star":"C","night":1,"ts":2,"coord":4,"mag":0,"conf":0.8}
{"type":"add_obs","id":"d1","star":"D","night":1,"ts":1,"coord":4,"mag":0,"conf":0.9}
{"type":"add_obs","id":"d2","star":"D","night":1,"ts":2,"coord":5,"mag":0,"conf":0.8}
{"type":"checkpoint","name":"before_fix"}
{"type":"solve"}
{"type":"correct_obs","id":"a1","coord":2}
{"type":"solve"}
```

Output (exit code 0) — note `reassignments` and the `explanation` prune
chain in the second `solve_result`:

```jsonl
{"line":1,"type":"ack","event":0,"op":"config","coordBins":6,"magBins":1,"capacity":4}
{"line":2,"type":"ack","event":1,"op":"add_obs","id":"a1"}
{"line":3,"type":"ack","event":2,"op":"add_obs","id":"b1"}
{"line":4,"type":"ack","event":3,"op":"add_obs","id":"b2"}
{"line":5,"type":"ack","event":4,"op":"add_obs","id":"c1"}
{"line":6,"type":"ack","event":5,"op":"add_obs","id":"c2"}
{"line":7,"type":"ack","event":6,"op":"add_obs","id":"d1"}
{"line":8,"type":"ack","event":7,"op":"add_obs","id":"d2"}
{"line":9,"type":"ack","event":8,"op":"checkpoint","name":"before_fix","depth":1}
{"line":10,"type":"solve_result","event":9,"status":"SAT","stats":{"propagation":19,"backtrack":3},"budget":{"requested":{"propagation":100000,"backtrack":10000},"remaining":{"propagation":99981,"backtrack":9997}},"trigger":[1,2,3,4,5,6,7],"explanation":[{"kind":"assign","night":1,"star":"A","cell":1,"events":[1]},{"kind":"branch","night":1,"star":"B","cell":2,"events":[2]},{"kind":"assign","night":1,"star":"B","cell":2,"events":[2]},{"kind":"branch","night":1,"star":"C","cell":3,"events":[4]},{"kind":"assign","night":1,"star":"C","cell":3,"events":[4]},{"kind":"branch","night":1,"star":"D","cell":4,"events":[6]},{"kind":"assign","night":1,"star":"D","cell":4,"events":[6]}],"model":{"1":{"A":{"cell":1,"coord":1,"mag":0,"obs":"a1","conf":0.9},"B":{"cell":2,"coord":2,"mag":0,"obs":"b1","conf":0.9},"C":{"cell":3,"coord":3,"mag":0,"obs":"c1","conf":0.9},"D":{"cell":4,"coord":4,"mag":0,"obs":"d1","conf":0.9}}},"cells":{"1":{"A":1,"B":2,"C":3,"D":4}},"superseded":[{"obs":"b2","star":"B","night":1,"cell":3,"reason":"cell_not_selected"},{"obs":"c2","star":"C","night":1,"cell":4,"reason":"cell_not_selected"},{"obs":"d2","star":"D","night":1,"cell":5,"reason":"cell_not_selected"}],"reassignments":[]}
{"line":11,"type":"ack","event":10,"op":"correct_obs","id":"a1"}
{"line":12,"type":"solve_result","event":11,"status":"SAT","stats":{"propagation":19,"backtrack":0},"budget":{"requested":{"propagation":100000,"backtrack":10000},"remaining":{"propagation":99981,"backtrack":10000}},"trigger":[10],"explanation":[{"kind":"assign","night":1,"star":"A","cell":2,"events":[1,10]},{"kind":"prune","night":1,"star":"B","cell":2,"constraint":"exclusive_cell","cause":{"star":"A","events":[1,10]}},{"kind":"assign","night":1,"star":"B","cell":3,"events":[3]},{"kind":"prune","night":1,"star":"C","cell":3,"constraint":"exclusive_cell","cause":{"star":"B","events":[3]}},{"kind":"assign","night":1,"star":"C","cell":4,"events":[5]},{"kind":"prune","night":1,"star":"D","cell":4,"constraint":"exclusive_cell","cause":{"star":"C","events":[5]}},{"kind":"assign","night":1,"star":"D","cell":5,"events":[7]}],"model":{"1":{"A":{"cell":2,"coord":2,"mag":0,"obs":"a1","conf":0.9},"B":{"cell":3,"coord":3,"mag":0,"obs":"b2","conf":0.8},"C":{"cell":4,"coord":4,"mag":0,"obs":"c2","conf":0.8},"D":{"cell":5,"coord":5,"mag":0,"obs":"d2","conf":0.8}}},"cells":{"1":{"A":2,"B":3,"C":4,"D":5}},"superseded":[{"obs":"b1","star":"B","night":1,"cell":2,"reason":"cell_not_selected"},{"obs":"c1","star":"C","night":1,"cell":3,"reason":"cell_not_selected"},{"obs":"d1","star":"D","night":1,"cell":4,"reason":"cell_not_selected"}],"reassignments":[{"star":"A","night":1,"from":1,"to":2,"cause":{"constraint":"exclusive_cell","trigger":[10]}},{"star":"B","night":1,"from":2,"to":3,"cause":{"constraint":"exclusive_cell","trigger":[10]}},{"star":"C","night":1,"from":3,"to":4,"cause":{"constraint":"exclusive_cell","trigger":[10]}},{"star":"D","night":1,"from":4,"to":5,"cause":{"constraint":"exclusive_cell","trigger":[10]}}]}
```

### UNSAT with minimal core (exit 3)

```jsonl
{"line":1,"type":"ack","event":0,"op":"config","coordBins":1,"magBins":1,"capacity":2}
{"line":2,"type":"ack","event":1,"op":"add_obs","id":"o1"}
{"line":3,"type":"ack","event":2,"op":"add_obs","id":"o2"}
{"line":4,"type":"solve_result","event":3,"status":"UNSAT","stats":{"propagation":5,"backtrack":0},"budget":{"requested":{"propagation":100000,"backtrack":10000},"remaining":{"propagation":99995,"backtrack":10000}},"trigger":[1,2],"explanation":[{"kind":"assign","night":0,"star":"s1","cell":0,"events":[1]},{"kind":"prune","night":0,"star":"s2","cell":0,"constraint":"exclusive_cell","cause":{"star":"s1","events":[1]}},{"kind":"conflict","constraint":"exclusive_cell","night":0,"star":"s2","events":[1,2]}],"conflict":{"constraint":"exclusive_cell","night":0,"events":[1,2]},"unsatCore":{"events":[1,2],"obs":["o1","o2"],"constraints":["exclusive_cell"]}}
```

### PENDING on budget exhaustion, never UNSAT (exit 4)

Same UNSAT instance as above, but with a zero budget:

```jsonl
{"line":1,"type":"ack","event":0,"op":"config","coordBins":1,"magBins":1,"capacity":2}
{"line":2,"type":"ack","event":1,"op":"add_obs","id":"o1"}
{"line":3,"type":"ack","event":2,"op":"add_obs","id":"o2"}
{"line":4,"type":"solve_result","event":3,"status":"PENDING","stats":{"propagation":0,"backtrack":0},"budget":{"requested":{"propagation":0,"backtrack":0},"remaining":{"propagation":0,"backtrack":0}},"trigger":[1,2],"explanation":[],"reason":"BUDGET_EXCEEDED","exceeded":"propagation","partial":{"completedNights":{},"inProgress":{"phase":"static","constraint":"unique_key"}}}
```

### Invalid input (exit 2)

```json
{"type":"error","code":"INVALID_INPUT","line":1,"message":"line is not valid JSON"}
```
