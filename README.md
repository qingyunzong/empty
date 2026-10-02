# fx-net-settle

财务共享中心的多币种应收应付净额结算工具：以**精确有理数**（BigInt 分数）把多币种
发票折算成记账本位币，输出各主体净额；汇率三角矛盾时给出**最小冲突子集证书**，
可由 `verify` 命令独立复核。仅使用 Node.js 22 标准库，单机离线可运行。

## 快速开始

```bash
npm test              # node --test（8 个测试文件）
npm run example       # 等价于 bash examples/run.sh
node bin/settle.js settle examples/ok.jsonl --base CNY
```

## 事件格式（JSONL，每行一个事件）

| 事件 | 字段 | 说明 |
| --- | --- | --- |
| `addInvoice` | `{id, ccy, num, den}` | 主体 `id` 在币种 `ccy` 上的有符号头寸 `num/den`（正=应收，负=应付） |
| `setRate` | `{pair, num, den}` | 汇率边 `1 FROM = num/den TO`，必须为正 |
| `correct` | `{refId, newNum, newDen}` | 更正某个 `addInvoice`/`setRate` 的 num/den（可链式、可撤销） |
| `undo` | `{eventId}` | 撤销任意事件（含 correct / undo 自身），幂等 |

每个事件可带可选 `eid`（缺省为 `e<行号>`），`correct`/`undo` 通过 `eid` 引用。

## 命令与退出码

```bash
node bin/settle.js settle <events.jsonl|-> [--base CCY] [--scale N]
node bin/settle.js verify <events.jsonl|-> <certificate.json>
node bin/settle.js hash   <events.jsonl|->
```

| 退出码 | 含义 |
| --- | --- |
| 0 | 可行，输出各主体净额与净额划转方案 |
| 1 | 不可行（输出最小冲突证书）/ 证书复核不通过 |
| 2 | `E_PARSE` 语法/形状错误（含行号） |
| 3 | `E_REF` 引用了未知或已失效的事件 |
| 4 | `E_PENDING` 汇率未决（缺基准币路径），**绝不当作不可满足** |

## 核心设计

- **精确有理数**：`src/fraction.js` 用 BigInt 分子/分母并约分，所有比较与运
  算精确，无浮点误差。
- **汇率三角一致性 = 半平面交**：每条 `setRate` 边 `(from,to,r)` 约束势函数
  `p[from] = r · p[to]`（`p[c]` 为 1 单位 c 折合本位币）。一致的汇率组即半平面
  交非空；当某简单环的汇率乘积 ≠ 1 时可行域为空。该简单环即**最小冲突子集**
  （其任何真子集都是森林，必然一致），作为证书输出（`src/rates.js`）。
- **证书独立复核**：`verify` 重新解析事件日志，逐项检查：事件存在且未被撤销、
  汇率当前值与证书一致、步骤构成简单环、环乘积 ≠ 1、去掉任意一步后恢复一致
  （最小性）、证书绑定的 `historyHash` 与日志当前状态一致（`src/verify.js`）。
- **增量前缀，不全量重算**：`correct`/`undo` 只做 O(1) 逆增量更新（头寸差量、
  更正链刷新），**从不重放事件日志**；`stats.eventsReprocessed` 恒为 0，测试
  以 3000 个事件断言其 ≤ N=2000。历史哈希是"当前有效日志"的纯函数（被撤销事
  件剔除、被更正事件取当前值），因此撤销后哈希与缩减后日志的哈希**逐位一致**，
  撤销撤销即恢复原哈希。
- **舍入只在最末出账**：净额全程保持精确分数；仅 `posted` 字段按 bankers
  rounding（half-to-even）舍入到 `--scale`（默认 2）位，并同时给出**实际误差**
  `roundingError` 与**误差界** `roundingBound = 1/(2·10^scale)`，测试随机验证
  误差永不越界（`src/rounding.js`）。
- **净额结算方案**：可行时输出唯一的精确净额解，并给出贪心净额划转方案
  （≤ n−1 笔，n 为非零主体数）。

## 错误码

- `E_PARSE`：非法 JSON、缺字段、非整数 num/den、den=0、汇率非正、pair 形状错误、
  eid 重复。错误对象带 `line` 行号。
- `E_REF`：`correct`/`undo` 引用未知 eid、引用已撤销事件、或试图更正 undo 事件。
- `E_PENDING`：存在非零头寸的币种没有通向基准币的汇率路径。输出 `missing`
  列表；这是"未决限界"，与"不可满足"严格区分（先判冲突、再判未决）。

## 验收对照

1. **三主体两币种净额为零**：`test/engine.test.js` + `examples/ok.jsonl`（A=0、
   B=−2450、C=+2450 CNY，合计 0）。
2. **证书可独立复核**：`test/verify.test.js` + `examples/conflict.jsonl` →
   `examples/certificate.json` → `verify` 全部检查通过；篡改乘积/删步骤/改日志
   均被拒绝。
3. **随机 N≤8 对照暴力枚举**：`test/bruteforce.test.js` 用固定种子生成 400 组
   随机日志（含 correct/undo），与从零全量重算的朴素实现逐位比对状态与净额。
4. **撤销后历史哈希一致**：`test/history.test.js` + `examples/run.sh` 第 5 步，
   撤销后哈希 == 缩减日志哈希，撤销撤销后 == 原哈希；3000 事件下
   `eventsReprocessed = 0 ≤ 2000`。

## 真实运行记录（2026-10-02，Node v22.22.1）

`npm test`：

```
# tests 8
# pass 8
# fail 0
```

`bash examples/run.sh`（节选，完整输出见 `/tmp/fx-settle-conflict.json` 与本节）：

1. `settle examples/ok.jsonl --base CNY` → exit 0：`A=0, B=-2450, C=2450`，
   `total: "0"`, `balanced: true`，划转方案 `B -> C 2450`，
   `historyHash: 63fdcfa7…c63298`。
2. `settle examples/conflict.jsonl --base CNY` → exit 1，证书：环
   `USD -> CNY -> EUR -> USD`，乘积 `35/36 ≠ 1`（7 · 1/8 · 10/9）。
3. `verify examples/conflict.jsonl examples/certificate.json` → exit 0，
   `valid: true`，10 项检查全部通过（含最小性与 historyHash 绑定）。
4. `settle examples/pending.jsonl --base CNY` → exit 4，
   `E_PENDING: missing exchange rate path to CNY for: EUR`。
5. `hash examples/ok.jsonl` 与 `hash examples/undo_demo.jsonl`（多一条
   发票 + 一条对它的 undo）输出**完全相同**的哈希
   `63fdcfa70b3dc4a7207f423170dbf0f16774d45745aac7ca67e1af7ec5c63298`。

## 目录结构

```
bin/settle.js      CLI 入口
src/fraction.js    BigInt 精确有理数
src/rounding.js    bankers 舍入 + 误差界
src/events.js      JSONL 解析与校验（E_PARSE/E_REF）
src/rates.js       汇率图势函数 + 最小冲突环提取
src/engine.js      增量账本（O(1) 逆增量 correct/undo、历史哈希、settle）
src/verify.js      证书独立复核
src/cli.js         命令分发与退出码
test/              node:test 测试（8 个文件）
examples/          示例数据 + run.sh + 已复核证书
```
