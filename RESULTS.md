# 实际测试结果

环境：Node.js v22.22.1，TypeScript 编译器（全局 tsc），Linux。

命令：`npm test`（即 `tsc -p tsconfig.json && node --test dist/test/*.test.js`）

最近一次运行输出（逐测试明细）：

```
ok 1 - mode: highest frequency wins, evidence reports the count
ok 2 - mode: ties break to the smaller value
ok 3 - empty range returns null
ok 4 - block update is atomic and old versions stay queryable
ok 5 - invalid ranges and versions are rejected
ok 6 - randomized cross-check vs sorted-count model (replacements, old versions, empty ranges)
# tests 6
# pass 6
# fail 0
```

`npm test` 汇总：

```
# tests 1
# pass 1
# fail 0
```

（外层 1 项为测试文件聚合，内含上述 6 个子测试，全部通过。）

随机化核对说明：种子 `0xC0FFEE`（mulberry32），60 轮；每轮随机长度数组、
1–12 次随机块替换（基于随机历史版本，范围可为空），随后 1–10 次随机查询
（随机版本、随机范围含空范围），与排序计数模型逐一 deepEqual，
并对频次证据在镜像数组上直接重计验证。
