# nakproto — 接收方 NAK 重传协议模拟器

发送方持续发送递增序号帧（无 ACK），接收方检测序号缺口后发送 NAK 请求重传。
发送方保留最近 `W=8` 帧的环形缓冲用于重传；接收方对同一缺口每 `20` tick 至多发一次
NAK（防抖）。仅使用 Python 3.11 标准库。

## 语义

1. 缺口补齐前，后续帧缓存在接收方，不交付。
2. NAK 请求的帧已滑出发送方窗口时，发送方回 `RANGE_ERR`，接收方转入 `FAILED` 并停止交付。
3. 重复 NAK 不影响发送方（幂等，环形缓冲不受扰动）。
4. 交付严格递增且去重（重复帧直接丢弃）。

## 虚拟时钟 tick 模型

每个 tick 分三个阶段：

1. **发送阶段**：发送方发出下一帧；按脚本判定丢失，否则本 tick（加可选延迟）到达。
2. **到达阶段**：接收方依次处理 本 tick 新帧 → 延迟帧 → 重传帧；
   按序交付、乱序缓存、重复丢弃。
3. **NAK 阶段**：对每个仍未补齐的缺口，若距上次 NAK ≥ `debounce` tick 则发 NAK；
   发送方立即应答：帧在窗口内 → 下一 tick 重传到达；否则回 `RANGE_ERR` → 接收方 `FAILED`。

## 运行

```bash
python -m nakproto run loss_script.json           # 输出交付序列与 NAK 日志（JSON）
python -m nakproto run loss_script.json --trace   # 附带逐 tick 事件轨迹
```

退出码：`0` = 全部交付（OK），`1` = FAILED/INCOMPLETE，`2` = ConfigError。

## 脚本格式（loss_script.json）

```json
{
  "frames": [1, 2, 3, 4, 5, 6, 7, 8],
  "loss": [3],
  "loss_permanent": [],
  "delay": {"3": 1},
  "window": 8,
  "debounce": 20
}
```

- `frames`：发送序号序列，必须严格递增，否则抛 `ConfigError`（`loss` /
  `loss_permanent` 列表同样要求递增）。
- `loss`：仅首次发送丢失的序号；`loss_permanent`：每次发送（含重传）都丢失的序号。
- `delay`：可选，某帧首次到达额外延迟的 tick 数（用于构造乱序）。

## 参考枚举时序表（验收场景 a：帧 3 丢失）

脚本：`frames=[1..8], loss=[3], window=8, debounce=20`

| tick | 发送 | 到达        | 交付      | NAK              |
|-----:|------|-------------|-----------|------------------|
| 0    | 1    | 1           | 1         |                  |
| 1    | 2    | 2           | 2         |                  |
| 2    | 3    | （丢失）    |           |                  |
| 3    | 4    | 4（缓存）   |           | NAK(3)→RETRANSMIT |
| 4    | 5    | 5, 3(重传)  | 3, 4, 5   |                  |
| 5    | 6    | 6           | 6         |                  |
| 6    | 7    | 7           | 7         |                  |
| 7    | 8    | 8           | 8         |                  |

最终交付 `[1,2,3,4,5,6,7,8]`，NAK 日志 `[{tick:3, seq:3, response:RETRANSMIT}]`。

其余验收场景：

- **b) 防抖**：`frames=[1..30], loss_permanent=[3]` → seq 3 的 NAK 仅在 tick 3 与 tick 23，
  任意 20 tick 窗口内至多 1 个。
- **c) 滑出窗口**：`frames=[1..20], loss_permanent=[3]` → tick 10 帧 3 被逐出环形缓冲，
  tick 23 的 NAK 得到 `RANGE_ERR`，接收方 `FAILED`，交付冻结为 `[1,2]`。
- **d) 乱序无缺口**：`frames=[1..6], delay={"3":1}` → tick 3 帧 4 先于帧 3 到达（缓存后补齐），
  全程零 NAK，交付 `[1..6]`。

## 测试

```bash
python -m unittest discover -v
```

真实运行结果（Python 3.14.4，2026-09-30）：

```
Ran 28 tests in 0.202s

OK
```

28 个测试全部通过，覆盖：场景 a（NAK 检测时刻 / 参考时序表 / 连续交付）、
场景 b（20 tick 防抖）、场景 c（RANGE_ERR→FAILED 交付冻结）、场景 d（乱序零 NAK）、
重复 NAK 幂等、环形缓冲逐出、严格递增去重、ConfigError 校验及 CLI 行为。

## 代码结构

- `nakproto/config.py` — 脚本解析与校验，`ConfigError`
- `nakproto/protocol.py` — `Sender`（W=8 环形缓冲）、`Receiver`（缺口检测/防抖 NAK）、`run_simulation`
- `nakproto/__main__.py` — CLI 入口
- `tests/` — unittest 测试套件
- `loss_script.json` — 示例脚本（场景 a）
