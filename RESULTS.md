# 验收结果（组 17：结算系统费率同步）

环境：Node.js v22.22.1，仅标准库 + node:test，单机离线。
运行日期：2026-10-02。以下均为真实运行输出，未手工编造。

## 测试总览

命令：`node --test test/*.test.js`

```
ok 1 - test/fee.test.js
ok 2 - test/sync.test.js
ok 3 - test/windows.test.js
# tests 3
# pass 3
# fail 0
# duration_ms 4107.964608
```

（3 个测试文件共 14 个用例，全部通过。）

## 验收 1：1 万交易 × 50 规则版本，区间重放哈希 = 全量

数据集：50 个规则版本（add + 10 次 revoke，窗口互相重叠、均声明 priority），
10000 笔交易，ts ∈ [0, 100000)。`test/sync.test.js` 断言：

- 全量重放哈希 == 10 个相邻子区间重放拼接后的哈希；
- 增量构建的账本哈希 == 从零全量重放哈希；
- 每个子区间账本哈希 == 该区间重放哈希。

CLI 实证（`node cli.js sync|verify`，数据集 seed=17）：

```
sync:   {"processed":10000,"skipped":0,"txOffset":10000,"checkpointWritten":true,"ledgerSize":10000}
verify 全区间: count=10000 totalFee=100701692
  replayHash=996e239304b530446119d7909edb3fbe8303414dc53f49d99d26da6ecb4b3a87
  ledgerHash=996e239304b530446119d7909edb3fbe8303414dc53f49d99d26da6ecb4b3a87 match=true
verify [30000,40000): count=986 totalFee=16367032
  replayHash=ledgerHash=4ad680af790e9a5779557d1105602231f2514a346313b06573e325f18f2bdc41 match=true
```

## 验收 2：写位点前 kill，恢复补发不重复

`--debug-crash=before-checkpoint` 模拟账本落盘（fsync）后、位点写入前崩溃：

```
第 1 次 sync（崩溃）: {"processed":500,"checkpointWritten":false}   state/ 下无 position.json
第 2 次 sync（恢复）: {"processed":0,"skipped":500,"checkpointWritten":true}
ledger.ndjson 行数 = 500（无重复行，txId 唯一）
补发 late-1 (ts=12345, 落在已结算区间) 后再 sync: {"processed":1}
verify 全区间: count=501 replayHash=ledgerHash=d44bd53a…afc156 match=true
```

机制：位点用 tmp+fsync+rename 原子写；恢复时从旧位点重放，账本按 txId 去重，
补发交易只追加增量条目（增量更正），不做全量重算。

## 验收 3：n≤8 枚举规则生效窗对照费用

`test/windows.test.js`：n=1..8，每个 n 随机生成 60 组规则（含随机 revoke），
对 `effectiveWindows` 的每个窗口在起点/中点/终点前采样，与独立暴力扫描
（逐规则过滤 + 优先级排序）对照 ruleId/rateBps/fee，并校验窗口连续无缝覆盖
整个规则时间线。480 组随机用例全部一致。

## 验收 4：并列最优输出稳定且费用可解释

`test/fee.test.js` + CLI 实证：两条 rateBps=100 的规则并列最优时，

```
fee --amount 20000 --at 50 →
{"ruleId":"rA","rateBps":100,"fee":200,"tied":["rA","rB"],
 "candidates":[{"ruleId":"rA","priority":1},{"ruleId":"rB","priority":2}],
 "selected":{"ruleId":"rA","priority":1}}
```

- 并列规则全部报告（`tied`/`candidates`），再按固定优先级（priority 升序，
  同级按 ruleId 字典序）选择；
- 连续 25 次求值与两次 CLI 调用输出逐字节相同（稳定）；
- 费用可解释：fee = floor(amount × rateBps / 10000) = 20000×100/10000 = 200。

## 错误码

```
规则重叠未声明优先级: {"error":"rules a and b overlap without declared priority","code":40}  exit=40
时间倒流(validTo<=validFrom): {"error":"rule a: validTo <= validFrom","code":41}              exit=41
```

## 命令用法

```
node cli.js sync   --rules rules.ndjson --tx tx.ndjson --state state/ [--debug-crash=before-checkpoint]
node cli.js fee    --rules rules.ndjson (--tx '<json>' | --tx-file f | --amount N --at T)
node cli.js verify --rules rules.ndjson --tx tx.ndjson --state state/ --from F --to T
node --test test/*.test.js
```
