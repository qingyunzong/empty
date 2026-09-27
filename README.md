# 有序事件屏障合流 (event_barrier)

多分区事件流的水位线对齐合流器。仅依赖 Python 3.11 标准库, 所有示例数据均为合成数据。

## 语义

- 每个分区产生**数据事件**与**单调递增的水位线**(回退的水位线被忽略并计数)。
- 事件释放条件: **全部活跃分区**的水位线都**严格越过**事件时间, 即
  `min(活跃分区水位线) > event.time`。相等不可释放。
- 输出按 **(事件时间, 分区ID, 序号)** 全序排序释放。
- 分区空闲必须显式发送 `idle` 屏障标记; 空闲分区不参与最小水位线计算,
  `active` 算子恢复其活跃身份(水位线保持上次值)。
- 迟到事件(到达时最小活跃水位线已越过其事件时间)**不进入主输出**, 单独记录到 late 文件。
- 指定 `--state` 后每条算子处理完即原子落盘(`os.replace`), 重启恢复时:
  已提交输出按事件键精确去重**不重发**, 未释放的缓冲事件保留并可在恢复后继续释放。

## 运行

```bash
python3 event_barrier.py INPUT.jsonl --state state.json --out released.jsonl --late late.jsonl
# 或管道: cat input.jsonl | python3 event_barrier.py - 
```

- `INPUT.jsonl`: 输入算子文件, `-` 表示标准输入。
- `--state`: 状态文件(可选)。缺省为纯内存运行。
- `--out`: 已释放事件输出(JSONL, 追加写), 缺省为标准输出。
- `--late`: 迟到事件记录(JSONL, 追加写), 缺省不记录。
- 运行统计(released/late/duplicates/nonmonotonic_wm/buffered)打印到标准错误。

## 输入格式(每行一个 JSON 算子)

| op | 字段 | 含义 |
|---|---|---|
| `event` | `partition`, `time`, `seq`, `payload` | 数据事件 |
| `watermark` | `partition`, `time` | 推进分区水位线(必须单调) |
| `idle` | `partition` | 显式空闲屏障标记 |
| `active` | `partition` | 恢复分区为活跃 |
| `commit` | — | 立即将状态落盘 |

空行与 `#` 开头的行被忽略。

## 输出格式

已释放事件(每行一个 JSON, 按 `(time, partition, seq)` 升序):

```json
{"time": 7, "partition": 0, "seq": 1, "payload": "order-7"}
```

迟到事件记录:

```json
{"time": 6, "partition": 1, "seq": 1, "payload": "too-late", "reason": "late", "min_active_watermark": 8}
```

## 验收边界(已由 unittest 覆盖)

两活跃分区水位线 10 和 5: 时间 7 事件不能释放(min=5); 分区 1 推进到 7(相等)仍不可释放;
推进到 8 后释放。见 `AcceptanceBoundaryTest`。

## 测试

```bash
python3 -m unittest test_event_barrier -v
```

## 已知限制

- `emitted` 事件键集合用于重启后精确去重, 会随输出量线性增长; 生产系统应按
  "水位线下界以下不再可能出现" 的假设做裁剪, 本实现未做(未验证其最优性)。
- 单线程逐条处理, 未做吞吐优化。
