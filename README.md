# 食品灭菌釜控制程序离线验证

Node.js 22、仅标准库、`node:test`。对操作员命令、联锁传感器 ack 与阀门反馈组成的
历史做离线核验：判定是否违反安全联锁，并在模拟掉电后把分段命令日志恢复到确定状态。

## 组成

- `src/machine.js` — 参考自动机（安全联锁状态机）。状态：
  `door: OPEN|CLOSED|LOCKED`、`heat: OFF|ON`、`vent: CLOSED|OPEN`、
  `pressure: UNKNOWN|LOW|HIGH`（传感器认知，只能由 ack 确认）。
- `src/verifier.js` — 线性化核验器（独立规则表实现）。检查联锁守卫与 cmd/ack
  因果（ack 必须有因果前导命令，否则 `CAUSALITY` 违例）。输出
  `{ verdict, safeState, violation, minimalViolation }`，其中
  `minimalViolation` 是最小违例前缀。
- `src/log.js` — 分段命令日志：`append(cmd)`、`ack(sensor)`、`commit()`。
- `src/fault.js` — 故障注入：`truncateAt(file, byteOffset)` 按字节截断模拟掉电。
- `src/cli.js` — 演示场景，输出 JSON。

## 持久化格式与故障模型

日志目录内每批（segment）一个文件，manifest 只追加：

```
seg-<n>.log:  @SEG <n>
              R <json event>          ...
              @COMMIT <n> <count> <crc16>
manifest.log: @MANIFEST <n>           (每提交一批追加一行)
```

`commit()` 的写入顺序定义两个故障点：

| 故障点 | 掉电位置 | 恢复结果 |
|---|---|---|
| 1 | 写完 data、未写 `@COMMIT` | 丢弃该批（`discarded`），半条命令不生效 |
| 2 | 写完 `@COMMIT`、未写 manifest | 整批可见（恢复扫描 commit 记录，不依赖 manifest） |

恢复规则：有合法 `@COMMIT`（条数 + crc 校验通过）的段可见；无合法 `@COMMIT`
且不在 manifest 中的段是未提交尾部，静默丢弃；在 manifest 中但校验失败的段
报告 `ERR_CORRUPT` 并指出段号，扫描在第一个坏段处停止。恢复结果确定，
重复恢复与按 seed 重放结果一致。

## 运行

```
node --test     # 验收测试
node src/cli.js # 场景演示
```

## 验收覆盖

1. `test/random.test.js` — 5000 个 seed、≤9 步随机历史，核验器与参考自动机
   逐状态对照（verdict / 违例位置 / safeState / 最小前缀）。
2. `test/interlock.test.js` — 升温未达压强却开排汽 → `VIOLATION` + 最小前缀；
   未知 ack 保持 `UNKNOWN`，不判安全；无因果 ack → `CAUSALITY`。
3. `test/recovery.test.js` — 两类故障点重启后状态可预测、重复恢复一致、
   seed 重放一致；被丢弃的段号可复用，无半条命令。
4. `test/corrupt.test.js` — 截断/篡改已提交段 → `ERR_CORRUPT` 识别坏段。

## 真实输出

`node --test`：

```
ok 1 - test/corrupt.test.js
ok 2 - test/interlock.test.js
ok 3 - test/random.test.js
ok 4 - test/recovery.test.js
# tests 4
# pass 4
# fail 0
# duration_ms 2979.262599
```

`node src/cli.js`（节选，完整输出为 5 个 JSON 场景）：

```
=== heat without pressure, then open_vent ===
{
  "verdict": "VIOLATION",
  "safeState": {
    "door": "LOCKED",
    "heat": "ON",
    "vent": "CLOSED",
    "pressure": "UNKNOWN"
  },
  "violation": {
    "index": 3,
    "event": {
      "type": "cmd",
      "name": "open_vent"
    },
    "kind": "INTERLOCK",
    "reason": "open_vent requires pressure HIGH (sensor-confirmed), got UNKNOWN"
  },
  "minimalViolation": [
    { "type": "cmd", "name": "close_door" },
    { "type": "cmd", "name": "lock_door" },
    { "type": "cmd", "name": "heat_on" },
    { "type": "cmd", "name": "open_vent" }
  ]
}

=== fault point 1: data without commit -> discarded ===
{
  "events": [
    { "type": "cmd", "name": "close_door" },
    { "type": "cmd", "name": "lock_door" }
  ],
  "discarded": [ 1 ],
  "corrupt": [],
  "replay": { "door": "LOCKED", "heat": "OFF", "vent": "CLOSED", "pressure": "UNKNOWN" }
}

=== fault point 2: commit without manifest -> visible ===
{
  "events": [
    { "type": "cmd", "name": "close_door" },
    { "type": "cmd", "name": "lock_door" },
    { "type": "cmd", "name": "heat_on" },
    { "type": "ack", "sensor": "pressure", "value": "HIGH" }
  ],
  "discarded": [],
  "corrupt": [],
  "replay": { "door": "LOCKED", "heat": "ON", "vent": "CLOSED", "pressure": "HIGH" }
}

=== truncated manifested segment -> ERR_CORRUPT ===
{
  "events": [],
  "corrupt": [
    { "segment": 0, "error": "ERR_CORRUPT", "reason": "missing @COMMIT" }
  ]
}
```
