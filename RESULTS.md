# RESULTS

环境：Node.js v22.22.1，仅标准库，单机离线。以下全部为真实运行输出。

## 1. 测试：`node --test`

```
TAP version 13
# Subtest: test/history.test.js
ok 1 - test/history.test.js
  ---
  duration_ms: 11683.561351
  type: 'test'
  ...
1..1
# tests 1
# suites 0
# pass 1
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11802.509645
```

子测试明细（`node test/history.test.js`）：

```
ok 1 - 1. isAncestor matches enumeration of all topological orders
ok 2 - 2. diamond concurrency merges deterministically regardless of order
ok 3 - 2b. CLI: node cli.js merge h1 h2 is deterministic
ok 4 - 3. cyclic and missing-parent histories are rejected
ok 5 - 4. undo rejects non-leaf with ERR_CONFLICT and keeps a tombstone
ok 6 - 5. corrupted heads/index files are rebuilt from the event graph with a report
ok 7 - 6. identical payloads under different ids are never auto-merged
# pass 7
# fail 0
```

## 2. CLI 演示（钻石并发 → 确定性合并 → 撤销 → 重建）

构造：alice 与 bob 在同一根事件 `R` 上各自离线更正，产生并发分支 `A`、`B`。

```
$ node cli.js --dir /tmp/demo2 heads
{"heads":["e19ddc9606141d65b6430891a190c1989ddd8d973","ee69b79a1103d5efaa031416342240710fa68e97c"],"rebuilt":false}

$ node cli.js --dir /tmp/demo2 is-ancestor A B
{"a":"e19ddc9606141d65b6430891a190c1989ddd8d973","b":"ee69b79a1103d5efaa031416342240710fa68e97c","result":false}
```

并发由父子闭包判定（`is-ancestor` 双向均为 false），未使用任何时钟。

```
$ node cli.js --dir /tmp/demo2 merge A B
{"head":"e009d76cc55bfc194ea9592af734e0953f6b77671","created":true}

$ node cli.js --dir /tmp/demo2 merge B A
{"head":"e009d76cc55bfc194ea9592af734e0953f6b77671","created":false}
```

`merge A B` 与 `merge B A` 产生同一个确定性 head（父集合排序 + 内容寻址 id），输入顺序无关，且幂等不重复写块。

```
$ node cli.js --dir /tmp/demo2 checkout M
[{"id":"e4a8bd1f...","kind":"event","author":"alice","counter":1,"payload":{"seq":[1,2,3]}},
 {"id":"e19ddc96...","kind":"event","author":"alice","counter":2,"payload":{"seq":[1,2,4]}},
 {"id":"ee69b79a...","kind":"event","author":"bob","counter":1,"payload":{"seq":[1,5,3]}},
 {"id":"e009d76c...","kind":"merge","author":"merge","counter":1,"payload":{"merged":["e19ddc96...","ee69b79a..."]}}]
```

撤销非叶子被拒绝（stderr JSON，exit=1）；撤销叶子 head 成功并保留墓碑块：

```
$ node cli.js --dir /tmp/demo2 undo R
{"error":"ERR_CONFLICT","message":"cannot undo non-leaf head e4a8bd1f...","details":{"head":"e4a8bd1f...","children":["e19ddc96...","ee69b79a..."]}}
exit=1

$ node cli.js --dir /tmp/demo2 undo M
{"undone":"e009d76c...","tombstone":"t2e00b466d486d8299dacc5918784e1147fc741e7","heads":["e19ddc96...","ee69b79a..."]}
exit=0
```

heads 文件损坏后以事件图为准重建并报告（warning 走 stderr，结果走 stdout）：

```
$ echo '{"heads":["eBogus"]}' > /tmp/demo2/heads.json
$ node cli.js --dir /tmp/demo2 heads
stderr: {"warning":"HEADS_REBUILT","rebuilt":true,"indexOk":true,"headsOk":false,"fileHeads":["eBogus"],"computedHeads":["e19ddc96...","ee69b79a..."]}
stdout: {"heads":["e19ddc96...","ee69b79a..."],"rebuilt":true}
exit=0
```

## 3. 验收点对照

- 枚举小图全部拓扑序对照 `isAncestor`：测试 1（5 节点 DAG，全部拓扑序回溯枚举，逐对断言「x 在所有拓扑序中先于 y ⟺ isAncestor(x,y)」）。
- 钻石并发合并确定：测试 2 / 2b 与上文 CLI 输出，`merge(a,b) === merge(b,a)`，幂等。
- 成环与缺父拒绝：测试 3，手工构造含环与缺父的 `events.log`，加载即抛 `ERR_CYCLE` / `ERR_MISSING_PARENT`；append 缺父同样拒绝。
- 删非叶子报 `ERR_CONFLICT`：测试 4 与上文 CLI 输出；叶子删除保留 `kind:"tombstone"` 墓碑块。
- heads 损坏可重建：测试 5 与上文 CLI 输出，索引与 heads 矛盾时以事件图重建为准并报告。
