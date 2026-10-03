# 测试结果（真实运行记录）

- 日期: 2026-10-03T09:11:11Z
- 环境: v22.22.1, 仅标准库
- 命令: `node --test`

## 汇总

```
# tests 6
# suites 0
# pass 6
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 6105.670097
```

## 分文件结果（spec reporter）

```
✔ test/cli.test.js (5682.934191ms)
✔ test/consistency.test.js (6158.697296ms)
✔ test/helpers.js (1822.225247ms)
✔ test/null-unknown.test.js (1680.398394ms)
✔ test/optimizer.test.js (5236.717389ms)
✔ test/verify.test.js (2252.44116ms)
```

## 全部子测试（逐文件真实输出）

```
ok 1 - optimized physical plans match direct enumeration up to 300 rows
ok 2 - certificate records rewrite rule sequence and sampled input hashes
ok 1 - NULL join keys never join (inner join, both hash and nested)
ok 2 - aggregates ignore NULLs; all-NULL input yields NULL except COUNT
ok 3 - SUM/AVG/MIN/MAX over all-NULL group yield NULL, COUNT yields 0
ok 4 - HAVING three-valued output: unknown groups are reported, never silently dropped
ok 5 - WHERE with UNKNOWN drops the row (standard SQL), IS NULL finds NULLs
ok 6 - NOT over UNKNOWN stays UNKNOWN in WHERE
ok 1 - predicate pushdown moves single-side conjuncts below the join
ok 2 - HAVING conjuncts on group keys push below groupby
ok 3 - projection pruning drops unreferenced columns but keeps join keys and preserves duplicates
ok 4 - aggregate pushdown rewrites to partial/final and preserves NULL and duplicate semantics
ok 5 - tied lowest-cost physical plans are all reported
ok 6 - non-tied inputs pick the cheaper algorithm only
ok 1 - verify accepts an optimized plan against its logical original
ok 2 - verify rejects a wrong rewrite: OR-predicate illegally pushed below join
ok 3 - verify rejects a wrong rewrite: aggregate decomposed with the wrong function
ok 4 - verify rejects certificate with invalid rule preconditions
ok 5 - verify accepts certificates produced by the real optimizer
ok 1 - cli: sql runs a query and prints rows plus certificate
ok 2 - cli: explain prints plans and writes plan files; verify proves equivalence
ok 3 - cli: verify rejects a non-equivalent plan with E_NON_EQUIV
ok 4 - cli: verify accepts two SQL files with equivalent queries
ok 5 - cli: bench --rows N reports consistent hashes
ok 6 - cli: error codes E_PARSE, E_TYPE, E_UNSUPPORTED
```

## 验收标准对照

1. **≤300 行与直接枚举一致** — `test/consistency.test.js`：7 种规模（0..300 行）×
   3 随机种子 × 6 条查询，优化物理计划与直接枚举全量哈希一致；证书
   `fullCheck.equal === true`。✅
2. **NULL/unknown 边界** — `test/null-unknown.test.js`：NULL 连接键不连接、聚合忽略
   NULL、全 NULL 组 SUM/AVG/MIN/MAX=NULL 且 COUNT=0、HAVING unknown 组进入
   `unknown` 桶不静默丢弃、WHERE unknown 按 SQL 语义过滤。✅
3. **并列最低代价全部报告** — `test/optimizer.test.js`：2×2 连接 hash 与 nested
   代价相同（4），`bestPlans` 返回全部 2 个计划；10×10 时仅 hash 入选。✅
4. **错误改写被拒绝** — `test/verify.test.js` / `test/cli.test.js`：OR 谓词非法下推、
   错误聚合分解（AVG 冒充 SUM）、证书规则前置条件破坏、被篡改的计划文件，均以
   `E_NON_EQUIV` 拒绝，无近似通过。✅

## CLI 实测

```
$ node bin/cli.js bench --rows 50000
rows=50000 directMs=394.528 optimizedMs=226.704 equal=true tiedBestPlans=1 cost=7600100

$ node bin/cli.js explain examples/q1.sql --data data --out b.json
$ node bin/cli.js verify a.json b.json --data data
equivalent=true hash=14fae86cc3a6a39a… rows=2 unknownRows=0
```
