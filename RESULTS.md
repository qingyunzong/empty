# RESULTS

- 日期：2026-10-03
- 环境：Node.js v22.22.1（仅标准库），`node --test`
- 命令：`node --test`（工作区根目录，真实运行，未修改输出）

## 汇总

```
# tests 8
# suites 0
# pass 8
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 8791.769738
```

## 各测试文件（node --test --test-reporter=spec）

```
✔ test/audit-retract.test.js (1560.239951ms)
✔ test/cli.test.js (8912.717141ms)
✔ test/conflict.test.js (2455.525937ms)
✔ test/crash.test.js (1783.894484ms)
✔ test/enumerate.test.js (6691.807396ms)
✔ test/hash.test.js (3796.695147ms)
✔ test/helpers.js (2154.030796ms)
✔ test/processor.test.js (1916.574443ms)
ℹ tests 8 / pass 8 / fail 0
```

## 验收标准对照

1. **崩溃一致性**（test/crash.test.js）：`crashPoint: 'before-rename'` 在写完
   `cases.jsonl.tmp` 等 outbox tmp、rename 前注入崩溃；恢复时丢弃残留 tmp、
   重放 `wal.jsonl`，三个输出文件与无故障运行逐字节一致；`after-rename`
   崩溃同理；三次运行的 `wal.jsonl` 内容完全相同。✅
2. **audit 撤回回滚放行**（test/audit-retract.test.js）：RELEASE → 撤回 audit →
   QUAR → 新 pass audit → RELEASE → fail audit → QUAR；vision 撤回移除缺陷证据、
   审计链保留。✅
3. **枚举 ≤5 frame 对照**（test/enumerate.test.js）：1–4 frame 全枚举
   （case 归属 × vision 有无 × SKU 归属 × 两种 SKU 的 audit 组合，共 42,120 例）
   + 5 frame 确定性采样 3,000 例，与测试内独立参考实现的隔离集逐一相等。✅
4. **跨 SKU 冲突边界**（test/conflict.test.js）：同 case 两 SKU → CONFLICT 且不进
   release 列表；同 SKU 多 frame 正常 RELEASE；撤回一侧 vision 后回到单 SKU 边界
   恢复 RELEASE。✅

附加：HASH_BAD（test/hash.test.js，6 种非法 hash + 1 种合法）、水位线/迟到事件、
窗口联结边界、barcode 撤回、CLI 端到端（test/cli.test.js、test/processor.test.js）。

注：沙箱环境无法捕获子进程管道，CLI 测试通过文件重定向读取子进程
stdout/stderr（见 test/cli.test.js 的 runCli）。
