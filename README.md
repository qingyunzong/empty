# kvstore — 带 WAL 的页式键值库（ARIES 风格）

Python 3.11 标准库实现，无第三方依赖。

## 特性

- 事务接口：`begin / get / put / delete / commit / abort / checkpoint / recover`
- 日志记录含 LSN、事务前驱（prevLSN）、页号、前后镜像与 CRC32
- 提交返回前同步日志；脏页可早于提交被窃取（steal/no-force），页头保存 pageLSN
- 恢复：分析 → 按 pageLSN 幂等重做 → 沿事务链撤销未提交事务；
  撤销写带 undoNextLSN 的补偿记录（CLR），恢复中再次崩溃不会重复撤销
- 模糊检查点：记录活动事务表与脏页最早 LSN，检查点期间允许写入；
  仅在检查点发布且所需日志/脏页持久化后回收日志前缀
- 日志完整性：尾部不完整/撕裂记录被截掉；中段 CRC 损坏则报错并保持原文件
- 可注入文件适配器：在日志写、日志同步、页写、页同步、CLR 落盘、
  检查点发布等边界模拟崩溃与撕裂写

## 运行测试

```sh
python3.11 -m unittest discover -s tests -v
```

## JSON CLI

```sh
echo '{"actions":[{"op":"begin"},{"op":"put","tx":1,"key":"a","value":"1"},
                  {"op":"commit","tx":1},{"op":"crash"},{"op":"recover"},
                  {"op":"dump"}]}' | python3.11 -m kvstore.cli
```

输入为一个 JSON 脚本（`config` 可调页数/页大小/缓冲池容量，`dir` 指定
数据库目录），输出为每个动作的结果与恢复轨迹，轨迹中每一步都带有
`reason` 说明（如 `pageLSN 5 >= LSN 3: already applied, redo is
idempotent`）。支持的动作：`begin/get/put/delete/commit/abort/
checkpoint/crash/recover/dump/fault/torn`。

## 布局

- `kvstore/wal.py` — 日志记录编码/解析、截断与前缀回收
- `kvstore/pages.py` — 页文件与 LRU 缓冲池（WAL 规则：先日志后页）
- `kvstore/engine.py` — 事务、撤销（CLR）、模糊检查点
- `kvstore/recovery.py` — 分析/重做/撤销
- `kvstore/adapter.py` — 文件适配器与故障注入
- `kvstore/cli.py` — JSON CLI
