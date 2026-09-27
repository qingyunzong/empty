# 有序事件屏障合流（event_barrier）

多分区事件流合流器：各分区不断上报数据事件与单调水位线，只有当**全部活跃分区**
的水位线都**严格大于**某事件的事件时间时，该事件才被安全释放；输出按
`(event_time, partition, seq)` 排序。分区空闲必须显式发送 barrier 标记，否则
视为活跃并阻塞释放。状态持久化到磁盘，重启恢复后不会重发已提交输出；迟到事件
单独记录。仅依赖 Python 3.11 标准库。

## 运行

```sh
python3.11 event_barrier.py --state-dir .ebstate input.jsonl   # 从文件读
cat input.jsonl | python3.11 event_barrier.py                  # 从标准输入读
python3.11 -m unittest test_event_barrier -v                   # 运行测试
```

## 输入格式（JSONL，每行一条记录）

| 类型 | 示例 | 语义 |
| --- | --- | --- |
| 数据事件 | `{"type":"data","partition":0,"time":7,"seq":1,"payload":"x"}` | `seq` 为分区内序号，参与排序与去重 |
| 水位线 | `{"type":"watermark","partition":0,"time":10}` | 单调不减，回退被忽略；到达即视为活跃 |
| 屏障 | `{"type":"barrier","partition":1,"state":"idle"}` | `idle` 标记空闲（不再阻塞释放），`active` 恢复活跃 |

## 输出

- **stdout**：释放的有序事件，每行一条 JSON：
  `{"partition":0,"seq":1,"time":7,"payload":"x"}`，按 `(time, partition, seq)` 升序。
- **`<state-dir>/committed.jsonl`**：已提交输出日志，重启时据此去重，保证不重发。
- **`<state-dir>/late.jsonl`**：迟到事件（`time <= 本分区当前水位线`），含
  `reason`、原事件字段与当时水位线。
- **`<state-dir>/state.json`**：水位线、分区活跃状态与未释放缓冲区，用于重启恢复。

## 语义要点

- 释放条件：`event.time < min(全部活跃分区水位线)`（严格小于；相等不释放）。
- 未知分区默认活跃；活跃但无水位线的分区将地平线压为 `-∞`，阻塞一切释放。
- 重复 `(partition, seq)` 的数据事件被忽略；已提交事件在重启重放时直接跳过
  （判定迟到之前先查提交日志）。

## 示例

`examples/input.jsonl` 为合成数据，演示：水位线 10/5 阻塞时间 7 的事件、
水位线推进到 8 后释放、相等 7 不释放、迟到事件记录、空闲屏障解除阻塞。
