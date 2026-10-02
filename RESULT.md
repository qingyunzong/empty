# RESULT

提交前完整测试运行真实记录。

## 环境

- Node.js: v22.22.1（仅标准库，无第三方依赖）
- 平台： 单机离线，Linux x86_64
- 运行时间（UTC）: 2026-10-02T19:54Z
- 命令： `node --test`

## 总体结果

```
# tests 6
# pass 6
# fail 0
# duration_ms 17948.05794
```

6 个测试文件全部通过，共 27 个子测试，0 失败。

## 分文件结果（TAP 顶层输出）

```
ok 1 - test/a-inheritance.test.js
ok 2 - test/b-revoke.test.js
ok 3 - test/c-forbidden.test.js
ok 4 - test/cli-audit-counterexample.test.js
ok 5 - test/d-enumeration.test.js
ok 6 - test/errors.test.js
```

## 验收项覆盖

| 验收项 | 测试文件 | 子测试数 | 结果 |
| --- | --- | --- | --- |
| A 继承审批被车间 deny 截断 | test/a-inheritance.test.js | 3 | 通过 |
| B 撤销后历史偏差保留 | test/b-revoke.test.js | 2 | 通过 |
| C 两版本同釜冲突（约束胜） | test/c-forbidden.test.js | 3 | 通过 |
| D ≤8 审批/禁配枚举对照 | test/d-enumeration.test.js | 5 | 通过 |
| 错误码 exit 16/17/18 | test/errors.test.js | 9 | 通过 |
| audit / counterexample CLI | test/cli-audit-counterexample.test.js | 5 | 通过 |

## 说明

- D 项枚举规模：8 个候选审批的全部 2^8=256 子集（链闭合过滤后）在 3 个釜 × 2 个配方上做
  解释器 vs 独立暴力规格三方对照；禁配边 6 条候选的全部 2^6=64 子集 × 2 个探测配方对照；
  反例最小性由全子集枚举独立复核。
- 沙箱运行环境无法捕获子进程 stdio（spawnSync EPERM），因此 CLI 层断言退出码、
  错误消息内容通过库内直接调用断言（见 test/errors.test.js 头部注释）。
