# 灭菌釜控制程序离线验证

食品灭菌釜(retort)操作员命令、联锁传感器与阀门反馈组成历史, 离线判定是否违反安全联锁;
分段持久化日志模拟掉电, 恢复后重放到确定状态。Node.js 22, 仅标准库, `node:test`。

## 模型

- **相**: `IDLE → READY → HEATING → COOLING/VENTING → IDLE`
- **命令**: `LOCK_DOOR` `START_HEAT` `STOP_HEAT` `OPEN_EXHAUST`(排汽) `OPEN_DOOR`
- **传感器**: `DOOR` / `PRESSURE` / `TEMP`, 未收到 `ack` 前保持 `UNKNOWN`
- **安全联锁**: `HEATING` 中 `OPEN_EXHAUST` 须已确认 `PRESSURE=OK`; `OPEN_DOOR` 须已确认 `PRESSURE=ZERO`
- **判定**: `SAFE` / `VIOLATION`(给出最小违例前缀) / `UNKNOWN`(传感器未知, 不判安全)
- **因果**: `ack` 必须有因果前导命令(`PRESSURE`/`TEMP` ← `START_HEAT`, `DOOR` ← `LOCK_DOOR`), 否则历史不可线性化, 判 `VIOLATION`

## 持久化与故障点

每批 `commit` 三段写: `seg-NNNNNN.data`(JSONL + CRC32 尾行) → `seg-NNNNNN.commit` → `manifest.json`。

| 故障点 | 恢复结果 |
| --- | --- |
| 写完 data 未写 commit | 丢弃该批, 半条命令不生效 |
| 写完 commit 未写 manifest | 整批可见(commit 为权威), 重建 manifest |
| 字节截断 / 校验失败 | `ERR_CORRUPT` 标识坏段号, 其余段不受影响 |

恢复后 `replay(records)` 为纯函数, 同一 seed 生成的历史重放结果一致。

## 运行

```console
$ node --test
# tests 4
# pass 4
# fail 0
# duration_ms 4866.494311
```

## 验收覆盖

1. `test/random.test.js` — 2000 个 seed 的随机历史(≤9 步)对照独立参考自动机: 判定、违例位置、终态、最小前缀完全一致, 且 SAFE/UNKNOWN/VIOLATION 三类均被覆盖
2. `test/machine.test.js` — 升温未达压强开排汽 → `VIOLATION` + 最小前缀; 未知 ack → `UNKNOWN` 不判安全
3. `test/log.test.js` — 两类故障点重启后状态可预测, 恢复记录重放与期望历史求值逐 seed 一致
4. `test/log.test.js` — 字节截断注入 → `ERR_CORRUPT` 标识坏段

## 真实输出(`node demo.js`)

```console
== 场景1 升温未达压强开排汽 ==
{
  "verdict": "VIOLATION",
  "safeState": { "phase": "COOLING", "sensors": { "DOOR": "LOCKED", "PRESSURE": "LOW", "TEMP": "UNKNOWN" }, "isSafe": false },
  "minimalViolation": [ LOCK_DOOR, ack DOOR=LOCKED, START_HEAT, ack PRESSURE=LOW, OPEN_EXHAUST ],
  "violationReason": "OPEN_EXHAUST during HEATING before pressure reached (PRESSURE=LOW)"
}

== 场景2 PRESSURE 未知时开排汽 ==
{ "verdict": "UNKNOWN", "safeState": { "phase": "HEATING", ..., "isSafe": false }, "minimalViolation": null }

== 场景3 故障点1(data无commit)恢复 ==
segments: [1:visible, 2:discarded], records: [LOCK_DOOR], replay.phase: "READY"

== 场景4 故障点2(commit无manifest)恢复 ==
segments: [1:visible, 2:visible], manifestRebuilt: true, records: 3 条, replay.phase: "HEATING"

== 场景5 截断故障注入 ==
segments: [1:visible, 2:corrupt], errors: [{ code: "ERR_CORRUPT", segment: 2 }]
```

完整 JSON 见 `node demo.js` 实际输出(与上文一致, 此处仅折叠缩进)。

## 结构

- `src/machine.js` — 状态机、`evaluate` 线性化核验、`minimalViolation`
- `src/log.js` — `SegmentLog.append/ack/commit` 三段写与 `recover`
- `src/fault.js` — 指定字节截断的故障注入
- `src/verify.js` — `verify`(verdict/safeState/最小违例序列) 与 `replay`
- `src/crc32.js` / `src/rng.js` — CRC32 与 mulberry32 种子随机
