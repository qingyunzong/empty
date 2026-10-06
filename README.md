# paycore

支付中台事件溯源内核：授权冻结（freeze）、扣款（capture）、撤销（void）、
红冲（reverse）、分支（branch）与合并（merge）。Node.js 22，仅标准库，
`node:test` 测试，单机离线运行。

## 模型

- 金额全部为有理数 `num/den`（BigInt 精确运算，接受 `"n"`、`"n/d"`、
  `"12.34"` 精确十进制写法；拒绝浮点 number）。
- 账户额度上限 `limit` 为有理数；不变式：`frozen + captured <= limit`
  （可用余额 `available = limit - frozen - captured` 永不为负）。
- `freeze{tx,amt}`：按精确分数冻结。`amt<=0` 或超出可用额度 → `E_STATE`；
  `tx` 重复 → `E_STATE`。
- `capture{tx,amt}`：从冻结中扣款。结算额 `settled = ROUND_HALF_EVEN(amt)`
  舍入到分（1/100）。**舍入耦合**：先按 ROUND_HALF_EVEN 试算，若
  `frozen-amt + captured+settled > limit`（后续不可恢复），整个 capture
  以 `E_STATE` 失败，状态不变。成功后冻结按精确 `amt` 减少、账务按
  `settled` 增加；每笔扣款获得 id `c<n>`。
- `void{tx}`：整笔释放冻结，额度精确复原。
- `reverse{captureId}`：红冲。`captureId` 精确命中一笔则冲之；否则按前缀
  匹配所有可逆扣款，**并列可逆时按金额最小、再按 id 字典序**选取；
  无候选 → `E_REF`。
- `branch{fromEvent,name?}`：以当前分支有效日志的前 `fromEvent` 个事件为
  基点创建并切换到新分支（缺省名 `b<n>`）；越界 → `E_REF`。
- `merge{branch}`：把分支事件逐个重放到父分支当前顶端。任一事件违反规则
  即整体失败，返回 `E_STATE` 并携带**可验证反例**
  `details.counterexample = {index, event, stateBefore, cause}`，可独立核算
  （如 `frozen_before + requested > limit`）。成功后事件追加进父分支。
- `rollback{branch}`：分层撤销。仅丢弃该分支自身未合并事件；已合并进祖先
  的事件保存在祖先的事件列表中，子分支回滚不会撤销它们。存在活动子分支
  或已合并 → `E_STATE`。
- `use{branch}`：切换当前分支（`main` 为主干）。

## 持久化与恢复

append-only 文件，每条记录两行：

```
{"seq":n,"op":...}\n
#<sha256-of-record-line>\n
```

故障点定义为“写完记录、未写校验行”。打开（init/apply/state/replay）时
扫描到最近一条完整的“记录+校验”对，截断其后的残缺尾部，并向 stderr
输出恢复摘要 `recovery: {"intactRecords","droppedRecords","bytesRemoved"}`，
随后重放完整前缀重建状态——任意历史可回放。

## 错误码

- `E_PARSE`：JSON/金额/字段/操作名非法
- `E_REF`：引用了不存在的 tx、capture、branch 或事件下标
- `E_STATE`：违反不变式或状态冲突（含合并冲突、舍入不可恢复）
- `E_IO`：文件无法打开/写入/截断

## CLI

```
node src/cli.js init  <file> --limit 100/1
node src/cli.js apply <file> '{"op":"freeze","tx":"t1","amt":"1/3"}' [...]
node src/cli.js state <file>      # 恢复摘要到 stderr，状态 JSON 到 stdout
node src/cli.js replay <file>
```

## 库

- `src/rational.js`：`Frac` 精确分数、`roundHalfEvenCents`（ROUND_HALF_EVEN）
- `src/engine.js`：`Engine`（apply/snapshot）、`AppError`
- `src/store.js`：`Store.open/append`（截断恢复）
- `src/cli.js`：`runCli(argv, io)` 可进程内调用

## 测试与验收映射（`node --test`）

- `test/engine.test.js` — 验收1（冻结-扣款-撤销后额度精确复原，分数严格
  相等）、验收2（合并冲突返回可验证反例并独立核算）、分层撤销树、
  舍入耦合 `E_STATE`、reverse 选取序、回放一致性
- `test/store.test.js` — 验收3（三类断电注入：缺校验行/半行校验/撕裂写，
  截断后重放与崩溃前一致）、`E_IO`
- `test/random.test.js` — 验收4（50 个种子 × N≤10 随机操作，对照
  `test/simulator.js` 独立模拟器，逐操作结果与最终状态完全一致）
- `test/rational.test.js` — 分数运算与 HALF_EVEN 舍入
- `test/cli.test.js` — CLI 端到端（沙箱禁止 fork，进程内调用 `runCli`）
