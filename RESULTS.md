# RESULTS

All results below are real outputs captured on Node.js v22.22.1
(linux x64, offline, standard library only).

## Test suite (`node --test`)

```
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Per-test results (`node test/lib.test.js` / `node test/cli.test.js`):

```
ok 1 - acceptance 1: child rule overrides inherited parent rule
ok 2 - acceptance 2: insufficient balance splits across multiple levels
ok 3 - acceptance 3: restore fails with E_RESTORE when a mid-level balance changed
ok 4 - reverse restores a partial chargeback exactly along the original path
ok 5 - acceptance 4: enumerate matches brute-force reference on a small graph
ok 6 - acceptance 4: ties on equal covered amount break by depth, then node id
ok 7 - input validation raises coded LedgerError
ok 8 - processJsonl tags results with line numbers and skips blank lines
ok 9 - processJsonl reports parse and semantic errors with line numbers
ok 10 - LedgerError is an Error subclass
ok 1 - cli processes a JSONL case file and writes result.json
ok 2 - cli exits 1 and writes to stderr on invalid JSON
ok 3 - cli exits 1 and writes to stderr on semantic errors
ok 4 - cli exits 1 on missing input file and on wrong usage
```

14/14 tests pass.

## Acceptance mapping

1. **子级覆盖父级** — `test/lib.test.js` "acceptance 1": `t1` inherits
   `s1`'s `"parent"` rule so `m1` bears; `t2` overrides with `"self"` and
   bears itself.
2. **余额不足多级分摊** — "acceptance 2": 90 at `t1` splits
   `t1:30 → s1:40 → m1:20`; an unrecoverable remainder yields
   `status:"partial"`, `code:"E_INSUFFICIENT"`.
3. **撤销时中间层余额变化导致 E_RESTORE** — "acceptance 3": after
   `adjust` on `s1`, `reverse` fails atomically with `E_RESTORE`,
   balances untouched, audit keeps `restore_failed`; undoing the change
   lets the restore succeed in reverse path order.
4. **小图枚举所有路径对照** — "acceptance 4": `enumerate` on a 9-node
   graph is deep-compared against an independent brute-force reference
   for amounts 1/30/75/200; ties break by shallower depth, then node id.

## CLI end-to-end run

Command: `node cli.js examples/case.jsonl examples/result.json` → exit 0.

Input (`examples/case.jsonl`):

```jsonl
{"op":"add_node","id":"m1","balance":100,"rule":"self"}
{"op":"add_node","id":"s1","parent":"m1","balance":40,"rule":"self"}
{"op":"add_node","id":"t1","parent":"s1","balance":30,"rule":"self"}
{"op":"add_node","id":"t2","parent":"s1","balance":20,"rule":"parent"}
{"op":"chargeback","id":"cb1","node":"t1","amount":90}
{"op":"adjust","node":"s1","delta":15}
{"op":"reverse","chargeback":"cb1"}
{"op":"adjust","node":"s1","delta":-15}
{"op":"reverse","chargeback":"cb1"}
{"op":"chargeback","id":"cb2","node":"t2","amount":15}
{"op":"reverse","chargeback":"cb2"}
{"op":"enumerate","amount":50}
{"op":"chargeback","id":"cb3","node":"t1","amount":500}
```

Key results from `examples/result.json` (real output, condensed):

```
line 5  chargeback cb1 settled  steps=[t1:30, s1:40, m1:20]          # 多级分摊
line 7  reverse    cb1 E_RESTORE failedNode=s1 expected=0 actual=15  # 中间层余额变动
line 9  reverse    cb1 ok        restored=[m1:20, s1:40, t1:30]      # 逆序恢复
line 10 chargeback cb2 settled  steps=[s1:15]                        # t2 规则 parent → s1 承担
line 11 reverse    cb2 ok        restored=[s1:15]
line 12 enumerate  amount=50:
        m1 depth=0 covered=50 steps=[m1:50]
        s1 depth=1 covered=50 steps=[s1:40, m1:10]
        t1 depth=2 covered=50 steps=[t1:30, s1:20]
        t2 depth=2 covered=50 steps=[s1:40, m1:10]
line 13 chargeback cb3 partial E_INSUFFICIENT covered=170 uncovered=330
        steps=[t1:30, s1:40, m1:100]
```

## CLI error paths (real output)

```
$ node cli.js /tmp/bad.jsonl /tmp/out.json     # 含非法 JSON 行
E_PARSE: line 2: invalid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)
exit=1

$ node cli.js /tmp/bad2.jsonl /tmp/out.json    # 未知节点
E_UNKNOWN_NODE: line 1: unknown node: ghost
exit=1

$ node cli.js                                  # 参数不足
usage: node cli.js <case.jsonl> <result.json>
exit=1
```

Note: the CLI test suite exercises the CLI in-process via the exported
`run()` (the sandbox here forbids `child_process` spawn); the real
process-level runs above were executed directly from the shell.
