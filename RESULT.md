# RESULT

提交前测试真实结果记录。

- 环境：Node.js v22.22.1，仅标准库，离线
- 命令：`node --test`
- 日期：2026-10-03
- 结果：**全部通过（5/5 测试文件，15 个子测试）**

## 实测输出（`node --test`，原样记录）

```
ok 1 - test/acceptance.test.js
ok 2 - test/audit.test.js
ok 3 - test/counterexample.test.js
ok 4 - test/errors.test.js
ok 5 - test/property.test.js
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 5162.992636
```

## 覆盖对照

- 验收 A（继承审批被车间 deny 截断）：`test/acceptance.test.js` → A
- 验收 B（撤销后历史偏差保留）：`test/acceptance.test.js` → B
- 验收 C（两版本同釜冲突，约束胜）：`test/acceptance.test.js` → C
- 验收 D（≤8 审批/禁配枚举对照解释器 vs 暴力参考实现，1536 个世界）：
  `test/property.test.js`
- 错误码：版本回退 exit 16、审批链断裂 exit 17、禁配表循环 exit 18：
  `test/errors.test.js`
- 按釜重放审计与篡改检测：`test/audit.test.js`
- 最小反例审批集合：`test/counterexample.test.js`

## 备注

- 沙箱限制：`spawnSync` 孙进程在本环境被拦截（EPERM 且 stdio 丢失），
  因此 CLI 测试通过 `cli.js` 导出的 `main(argv, io)` 在进程内断言退出码；
  真实进程退出码已用 shell 手工验证（`node cli.js run ...; echo $?` → 16）。
