# RESULTS

日期：2026-10-04　环境：Node.js v22.22.1（仅标准库）

## 测试命令与真实结果

命令：`node --test`

```
# tests 5
# pass 5
# fail 0
# duration_ms 17330.328923
```

逐文件（`node <file>` 子测试统计，真实运行）：

| 文件 | 子测试 | 通过 | 失败 |
| --- | --- | --- | --- |
| test/cli.test.js | 5 | 5 | 0 |
| test/lexer.test.js | 4 | 4 | 0 |
| test/parser.test.js | 10 | 10 | 0 |
| test/random.test.js | 2 | 2 | 0 |
| test/solver.test.js | 8 | 8 | 0 |
| **合计** | **29** | **29** | **0** |

## 验收对照

1. **5 会员手工环可复现**：`test/solver.test.js` “5-member manual cycle …”，
   5×10000 环，canonical `M1>M2>M3>M4>M5`，minCash=0；`expect cycle` 用旋转写法
   声明仍匹配。CLI 实测（`node bin/net run examples/rules.net examples/obs.json
   --proof proof.json`）：`minCash=0 solutions=1`，环 `M1>M2>M3>M4>M5 amount=9950`。
2. **并列最优全部列出**：同文件 “tied optima …”，两组最小现金方案
   `A>B@10|A>C@10|B>C@5` 与 `A>B@5|A>B>C@5|A>C@5|A>C>B@5` 均列出，顺序确定
   （两次运行 proof JSON 逐字节一致）。
3. **币种混杂 / 跨日常量报错**：`test/parser.test.js`（`1 USD + 2 EUR` → E_CCY、
   跨日引用 → E_PARSE）、`test/solver.test.js`（USD 规则遇 EUR obligation →
   运行时 E_CCY）、`test/cli.test.js`（CLI 退出码 1 + 错误码）。
4. **随机 30 笔对照**：`test/random.test.js`，5 个种子 × 30 笔 / 4 会员，
   求解器 minCash 与独立 DFS 参考实现逐一相等；3 个小规模用例另做子集暴力
   （2^k 子集）上界校验；每个最优解独立验证净头寸不变、
   `gross - Σ环抵消 = residualTotal`、残余图无环。

## CLI 实测输出

```
$ node bin/net run examples/rules.net examples/obs.json --proof proof.json
USD: obligations=5 gross=49750 minCash=0 solutions=1
  solution 1: residualTotal=0
    cycle M1>M2>M3>M4>M5 amount=9950
proof written to proof.json
```
