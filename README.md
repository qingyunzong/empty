# wal-event-store

设备事件(启停 / 报警 / 计数)的仅追加 WAL 存储库与单机离线 CLI。
Node.js 22,仅标准库,测试使用 `node:test`。

## WAL 帧格式(小端)

| 偏移 | 长度 | 含义 |
|------|------|------|
| 0    | 4    | payload 长度 (uint32) |
| 4    | 4    | payload 的 CRC32 (IEEE, uint32) |
| 8    | 4    | 序列号 seq (uint32, 单调递增) |
| 12   | 1    | 提交标记 (0x00 未提交 / 0x01 已提交) |
| 13   | N    | payload (事件的 JSON 字节) |

## 提交协议与故障点

1. 写入完整帧(commit=0) → **故障点 `after_data`**
2. `fsync` 数据 → **故障点 `after_sync`**(数据已 sync,提交标记未写)
3. 原位写入提交标记 0x01 并 `fsync` → **故障点 `after_commit`**(提交标记已 sync)

恢复语义:扫描文件,保留"完整 + CRC 校验通过 + 提交标记已置位"的最长前缀,
其余尾部(不完整帧 / CRC 错误 / 未提交帧)一律截断。因此:

- `after_data` / `after_sync` 崩溃:事件恢复后**不可见**
- `after_commit` 崩溃:事件恢复后**必须可见**

每次打开存储(任何 CLI 命令)都会自动执行恢复,并在恢复后重建索引:
主索引 `eventId -> event`(唯一,重复返回 `E_DUP`)与二级索引
`deviceId+seq -> event`。

## CLI

```
node bin/cli.js <command> [--dir <数据目录,默认 ./data 或 $WAL_DIR>] [--fault <点>]
```

输入为 stdin 上的 JSON,输出为 stdout 上的 JSON。

- `append`  输入事件 `{eventId, deviceId, seq, type, ...}`,type ∈ `start|stop|alarm|count`
  → `{"ok":true,"seq":N}`
- `get`     输入 `{"eventId":"..."}` → `{"ok":true,"event":{...}}`
- `query`   输入 `{"deviceId":"...","seq":N}` → 单个事件;省略 `seq` → 该设备全部事件(按 seq 排序)
- `recover` → `{"ok":true,"records":N,"truncatedBytes":M}`
- `crash`   输入 `{"event":{...},"fault":"after_data|after_sync|after_commit"}`
  (fault 也可用 `--fault` 指定),在指定故障点模拟崩溃,退出码 101

## 退出码约定

| 码 | 含义 |
|----|------|
| 0   | 成功 |
| 1   | 未知错误 |
| 2   | `E_DUP`(eventId 重复) |
| 3   | `E_NOTFOUND` |
| 4   | `E_ARGS`(参数 / JSON 非法) |
| 5   | `E_IO` |
| 101 | `E_CRASH`(crash 命令模拟的崩溃) |

## 测试

```
node --test
```
