# limit-freeze-engine

银行卡额度冻结引擎。Node.js 22、仅标准库、`node:test`、单机离线、零依赖。

## 模型

- 时间为整数分钟，所有冻结/解冻/扣占按**半开区间** `[start, end)` 生效。
- 账户配置：总额度 `totalLimit`、商户类日子上限 `dailyCaps`、周期重置点（`periodMinutes` + `anchor`）、日长度 `dayMinutes`。
- **冻结（freeze）**：在 `[start, end)` 上占用额度；支持重叠冻结。
- **解冻（unfreeze）**：按子区间和/或金额部分解冻，区间可分裂为多个碎片。
- **扣占（capture）**：把冻结的一部分转为结算记录；结算在其发生周期内计入总额度占用，**跨周期重置后自动失效**；冻结则跨周期结转，直到 `end` 到期自动释放。
- **日上限口径**：同一 hold 的多个碎片在同一自然日只计一次（取最大碎片额），防止分裂重复计数；结算记录计入发生日。
- **冲突裁决**：`applyBatch` 按 `(priority 降序, seq 升序, 提交序)` 确定性排序后串行应用；`expectedVersion` 提供乐观并发控制。任何失败整体回滚，**不得部分扣占**。

## 错误码

| 码 | 含义 |
|---|---|
| `E_LIMIT` | 总额度或商户类日上限不足（附 `kind: total/daily` 与现场明细） |
| `E_INTERVAL` | 区间/金额/引用非法（`start>=end`、未知 hold、不重叠、时钟回拨等） |
| `E_PERIOD` | 区间起点落在已关闭周期（早于当前周期起点） |
| `E_RACE` | `expectedVersion` 与当前版本不一致（乐观锁冲突） |

## 输出

每次变更返回规范化区间集合：

- `segments`：按占用者签名规范化的不相交区间（含 `total`、`byCategory`、`holds`、`captures`）。
- `coalesced`：按金额签名进一步归并的占用视图。
- `merges`：**碎片合并证明**，逐条记录 `from: [[s,m],[m,e]] -> into: [s,e]` 及金额签名。
- 拒绝时返回 `code/reason/detail`，状态不变（版本号不前进）。

## 用法

```bash
node bin/cli.js run examples/demo.json     # 逐条应用并输出 JSONL
node bin/cli.js state examples/demo.json   # 只输出最终规范化状态
node bin/cli.js scenario 1                 # 运行内置验收场景 1..4
node --test                                # 全量测试
```

库接口：`new LimitEngine(config)`，`apply(op)` / `applyBatch(ops)` /
`freeze|unfreeze|capture|sweep` / `occupancyAt(t)` / `state()`。

## 验收与真实输出

### 1) 三个重叠冻结跨越周期重置（`node bin/cli.js scenario 1`）

A[0,90)300 + B[30,120)400 + C[60,150)200，周期重置点 t=60/120；B 在 t=50 被部分扣占 150。

```
occupancy: {"beforeReset_t59":{"total":850,"byCategory":{"DINING":300,"TRAVEL":550}},
            "afterReset_t61":{"total":900,"byCategory":{"DINING":500,"TRAVEL":400}}}
sweep(t=130): {"released":["A","B"],"expired":["cap1"]}
final segments: [[60,150,200]]    # 仅 C 跨周期结转存活
```

t=59 占用 850（A300+B400+结算150）；跨过 t=60 重置点后结算失效变为 900 中的构成改变
（A300+B400+C200，结算 cap1 不再计入），t=130 扫描后 A/B 到期自动释放，只有 C 结转。

### 2) 部分解冻分裂再合并（`node bin/cli.js scenario 2`）

H[0,100)100 → 解冻 [40,60) 分裂 → 同额同类 H2[40,60) 回填 → 归并。

```
splitSegments:    [[0,40],[60,100]]                 # 分裂后两个碎片
occupantSegments: [[0,40],[40,60],[60,100]]         # 回填后占用者视图
mergedSegments:   [[0,100]]                         # 金额签名归并结果
mergeProof: [
  {"from":[[0,40],[40,60]],"into":[0,60],"total":100,"byCategory":{"SHOPPING":100}},
  {"from":[[0,60],[60,100]],"into":[0,100],"total":100,"byCategory":{"SHOPPING":100}}
]
```

### 3) 并发等值请求确定性裁决（`node bin/cli.js scenario 3`）

总额度 100，三笔等值 60 冻结同优先级、seq 1/2/3；打乱提交顺序重放结果一致。

```
forward:  [{"op":"freeze r1","ok":true}, {"op":"freeze r2","code":"E_LIMIT"},
           {"op":"freeze r3","code":"E_LIMIT"}]
deterministic: true                                    # 乱序提交同一赢家 r1
stale: {"code":"E_RACE","reason":"stale expectedVersion",
        "detail":{"expected":0,"actual":1}}
```

### 4) 分钟级时间轴对照参考实现（`node bin/cli.js scenario 4`）

确定性伪随机生成 60 个操作（冻结/部分解冻/扣占），时间轴 480 分钟，
逐分钟对比引擎与独立参考实现（`src/ref.js`），并校验任意点占用不超上限。

```
{"minutes":480,"acceptedFreezes":19,"rejectedFreezes":18}
{"mismatches":0,"maxOccupancy":149,"totalLimit":250,"violations":[],
 "finalSegments":33,"mergeProofs":0}
```

### `node --test` 全量结果

```
✔ S1: three overlapping freezes across period resets
✔ S1b: limit rejection is E_LIMIT and does not partially deduct
✔ S2: partial unfreeze splits interval, refill merges with proof
✔ S2b: amount-partial capture reduces middle fragment
✔ S3: concurrent equal requests, deterministic single winner
✔ S3b: priority beats submission order
✔ S4: minute-by-minute cross-check vs reference implementation
✔ validation errors: E_INTERVAL and E_PERIOD
✔ auto-release at expiry via sweep and half-open semantics
✔ cross-period carryover: hold spans reset, capture expires at reset
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

### CLI 示例（`node bin/cli.js run examples/demo.json`，逐行 JSON）

```
{"ok":true,"op":"freeze A","state":{"version":1,...,"coalesced":[{"start":0,"end":90,"total":300,...}]}}
{"ok":false,"op":"freeze B","code":"E_LIMIT","reason":"daily category limit exceeded",
 "detail":{"kind":"daily","category":"DINING","day":0,"limit":600,"current":300,"requested":400}}
ok      freeze B        # 降为 200 后成功
ok      unfreeze A      # [40,60) 部分解冻，A 分裂
ok      capture B       # 部分扣占 100
ok      freeze C        # FUEL 300，跨 t=60/120 重置点
ok      sweep           # t=130：A/B 到期释放，结算失效，C 结转
```

## 文件

- `src/engine.js` — 引擎（冻结/解冻/扣占/扫描、限额校验、规范化与合并证明、批量裁决）
- `src/ref.js` — 独立参考实现（逐分钟暴力求和，用于对照验证）
- `src/scenarios.js` — 四个内置验收场景
- `bin/cli.js` — CLI（`run` / `state` / `scenario`）
- `test/engine.test.js` — `node:test` 验收测试（10 项）
- `examples/demo.json` — CLI 示例脚本
