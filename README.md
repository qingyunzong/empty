# buildcache — 增量文件构建缓存

纯 Python 3.11+ 标准库实现，无第三方依赖。

## 用法

```bash
python -m buildcache scan  <dir>   # 只检查：报告 dirty / up-to-date / STALE
python -m buildcache build <dir>   # 增量构建脏目标（拓扑序）
python -m buildcache clean <dir>   # 只删除 manifest 声明的产物及缓存元数据
```

`<dir>` 为含 `manifest.json` 的项目目录（缺省为当前目录）。

## manifest.json

```json
{
  "out/gen.txt": {"src": ["a.txt", "b.txt"], "cmd": "echo gen"},
  "out/top.txt": {"src": ["out/gen.txt"], "cmd": "echo top"}
}
```

目标名即产物相对路径；`src` 中引用其他目标名即构成依赖。命令不真正执行，
产物模拟为各输入文本的字节拼接（依赖目标贡献其产物内容）。

## 核心语义

- **指纹**：`SHA256(目标路径 + 各源路径/内容哈希 + 依赖目标指纹)`，完全不使用 mtime。
- **原子重写**：仅当指纹变化才重写；先写 `<target>.tmp` 再 `os.replace` 原子改名。
- **崩溃恢复**：`.buildcache/journal.json` 记录进行中操作。重启后：
  - tmp 已写、rename 前崩溃 → 回滚删除 tmp；
  - rename 后、状态未更新崩溃 → 依据 journal 补记 state。
  任何时刻都不会出现半成品 target 产物。
- **STALE**：源文件缺失时目标标记 STALE，旧产物保留不动。
- **clean**：只删 manifest 清单内的产物及其 tmp，未跟踪文件不受影响。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功 |
| 2  | manifest 缺失/损坏/非法 |
| 3  | 依赖循环 |
| 7  | 写失败（tmp/rename/state/journal） |

## 崩溃模拟（测试用）

```bash
BUILDCACHE_CRASH_AT=before_rename python -m buildcache build <dir>
BUILDCACHE_CRASH_AT=after_rename  python -m buildcache build <dir>
```

## 测试

```bash
python -m unittest discover -s tests -v
```

真实运行结果（Python 3.14.4，Linux）：

```
Ran 16 tests in 26.066s
OK
```

覆盖验收点：A 改无关文件/mtime 不重建；B 深层依赖变更级联重建；
C 两个故障点恢复一致（回滚 tmp / 补记 state，且恢复结果与干净重建一致）；
D 增量构建产物与全量重建枚举对照完全相同；另有 STALE、clean 边界与
exit 2/3/7 错误码用例。
