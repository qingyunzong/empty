# settlement-graph

机构结算有向图：事件溯源 + append-only 审计日志 + checkpoint 快照。Node.js 22，仅标准库。

## CLI

```sh
node cli.js add-edge <from> <to> [--dir=DIR] [--crash=before-checkpoint|after-checkpoint]
node cli.js delete-edge <from> <to> [--dir=DIR] [--crash=...]
node cli.js query-scc [--dir=DIR]
node cli.js verify-history [--dir=DIR]
```

数据目录默认为 `--dir` 或环境变量 `SETTLE_DIR` 或当前目录，包含：

- `append-audit.log`：JSON Lines 事件日志，每条含 `seq/type/args/prevHash/hash`，
  `hash = sha256(canonical(event))`，追加后 fsync。
- `checkpoint.json`：快照 `{lastSeq, lastHash, state, stateRoot, scc}`，
  先写 `checkpoint.json.tmp` 再原子 rename。

## 崩溃恢复

- commit 先把事件及 prevHash 追加到日志并 fsync，再应用状态、写 checkpoint。
- `--crash=before-checkpoint`：日志落盘后以退出码 75 退出；重启时恢复逻辑重放
  seq 大于 checkpoint.lastSeq 的日志条目（只执行一次），并补写 checkpoint。
- `--crash=after-checkpoint`：checkpoint 原子替换后以退出码 75 退出；重启时
  所有日志条目均已入 checkpoint，不会重复执行。

## verify-history

从 genesis 重放全部日志，校验：哈希链（prevHash/hash）、checkpoint 与日志的
对应关系、状态根 stateRoot、以及 checkpoint 中保存的 SCC 与重算结果一致。
日志任一字节被篡改即报错并以退出码 1 退出。

## 库用法

```js
import { Store, verifyHistory } from './src/store.js';
const store = Store.load(dir);
store.commit('add-edge', { from: 'a', to: 'b' });
console.log(store.graph.scc());
console.log(verifyHistory(dir)); // [] 表示一致
```

## 测试

```sh
node --test
```

`test/scc.test.js` 用独立的“双向可达”参考算法对 n<=7 的随机图与 n<=3 的
全部图对照 Tarjan SCC 结果；`test/store.test.js` 覆盖三条验收场景及
逐字节篡改检测。
