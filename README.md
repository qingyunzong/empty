# ilog

持久化半开区间集合 `[lo, hi)` 到单个 JSON 文件，纯 Python 3.11 标准库实现。

## CLI

```sh
python -m ilog.cli -f data.json add 0 10      # 添加区间并提交
python -m ilog.cli -f data.json remove 3 7    # 减去区间并提交
python -m ilog.cli -f data.json compact       # 合并相邻区间（走同一 commit 流程）
python -m ilog.cli -f data.json commit        # 提交当前状态
python -m ilog.cli -f data.json list          # 加载（必要时恢复）并打印
```

输出为 JSON：`{"intervals": [[lo, hi], ...], "recovered": null|"committed"|"rollback"}`。
错误（文件非 JSON、区间非法、权限失败）打印 `error[IO]` 或 `error[BAD_INTERVAL]` 并以退出码 2 结束。

## 提交协议与故障点

`commit()` 的步骤（`compact()` 复用同一流程）：

1. 序列化工作区状态写入 `<path>.tmp` 并 fsync —— 故障点 `after_tmp_write`
2. 写提交标记 `<path>.commit`（含 tmp 的 SHA-256）并 fsync —— 故障点 `after_marker_write`
3. `os.replace(tmp, main)` 原子替换并 fsync 目录 —— 故障点 `after_replace`
4. 清除提交标记

未 commit 的 `add`/`remove` 只存在于内存工作区。

## 启动恢复

- 无标记：主文件为准；遗留 tmp（崩溃于步骤 1 后）被丢弃，半提交区间不生效。
- 有标记且 tmp 完整（摘要匹配、内容合法）：崩溃于 replace 前，采用 tmp 的新状态并完成替换，清除标记，`recovered="committed"`。
- 有标记但 tmp 不存在：replace 已完成，主文件即新状态，清除标记，`recovered="committed"`。
- 有标记但 tmp 损坏（摘要不符或非法 JSON）：回退主文件，丢弃 tmp 与标记，`recovered="rollback"`。

## 故障注入

```python
import ilog
ilog.set_fault("after_marker_write")   # 武装一次性故障点
store.commit()                          # 抛出 ilog.InjectedFault，模拟崩溃
ilog.IntervalStore(path)                # 重新打开即触发恢复
```

## 测试

```sh
python -m unittest discover -s tests -v
```

最近一次真实运行结果见 `results.txt`。
