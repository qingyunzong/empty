# 显微成像中心扫描批调度

Node.js 22，仅用标准库与 `node:test`。为显微成像中心分配扫描批机时：视野数、物镜、互斥荧光通道、课题组配额、预约优先级；支持样本更正、设备维护撤销时段、层级回滚与故障回放。

## 运行

```bash
node --test test/*.test.js     # 测试
node bin/micro.js <命令> ...   # CLI（默认状态文件 microstate.json，事件日志 microstate.json.log）
```

## 命令

| 命令 | 说明 |
| --- | --- |
| `book <id> --group G --objective O --channels C[,C] --fields N [--priority P]` | 预约批次并重排待成像队列 |
| `scan [--until T]` | 出具图像：将 T 前（默认全部）计划视野转为不可改图像 |
| `correct <id> --delta N` | 样本更正：减少释放机时，增加只追加可行段 |
| `maintain --start S --end E` | 维护撤销时段 [S,E)，受影响批次迁移或明确失败 |
| `cancel <id>` | 撤销批次（已出具图像保留） |
| `replay [--to K]` | 从事件日志回放（可停在故障点 K），逐事件校验状态证明 |
| `table` / `--json` | 机时表；`--json` 输出机读结果 |

## 核心规则

- **通道互斥**：配置 `channelExclusions` 定义互斥对。同批通道组合含互斥对 → `CHANNEL_CONFLICT`（exit 10）；相邻时段使用互斥通道须留 `channelFlush` 冲洗间隔。
- **物镜切换成本**：相邻批次物镜不同须留 `switchCost` 机时。调度器对 n≤12 用子集 DP 求最小完工，更大规模按物镜聚类启发式。
- **服务策略**：优先级高者优先 → 配额未用尽者优先 → 最久未服务课题组优先 → 同优先级同配额按批 ID。同一课题组连续抢占达 `maxConsecutive` 次且他组可保持最优时必须让位（防抖动）。
- **维护迁移**：维护窗口撤销的时段由全量重排迁移；已出具图像不可改，窗口覆盖图像或迁移超出视界 `horizon` → 明确失败并回滚到上一代际。
- **层级回滚**：每次变更为一个批代际（含快照与状态证明）；失败操作整体丢弃，已出具图像永不在回滚范围内。
- **状态证明**：状态规范化 JSON 的 SHA-256，每个命令输出；事件日志逐条记录证明，`replay` 重放校验，篡改即 `PROOF_MISMATCH`。

## 错误码

- exit 10：`CHANNEL_CONFLICT`（通道冲突）、`MAINTENANCE_OVERLAP`（维护重叠）、`NEGATIVE_FIELDS`（负视野），stderr 输出冲突解释 JSON。
- exit 1：未知批次、越界视界、迁移失败、触碰已出具图像、证明不匹配等。

## 真实输出

预约三批（注意 b3 与 b1 同物镜被聚类，b2 前插入物镜切换）：

```
$ node bin/micro.js book b1 --group alpha --objective 20x --channels GFP --fields 4 --priority 1
机时表 gen=1 clock=0
start  end   kind              batch   group    objective channels
0      4     scan              b1      alpha    20x       GFP
状态证明 3dc238771cb5dce1 (gen=1, 已成像=0)

$ node bin/micro.js book b2 --group beta --objective 40x --channels DAPI --fields 3 --priority 0
机时表 gen=2 clock=0
start  end   kind              batch   group    objective channels
0      4     scan              b1      alpha    20x       GFP
4      6     gap:物镜切换          -       -        -         -
6      9     scan              b2      beta     40x       DAPI
状态证明 59f5814c3328300b (gen=2, 已成像=0)

$ node bin/micro.js book b3 --group alpha --objective 20x --channels Cy5 --fields 2 --priority 1
机时表 gen=3 clock=0
start  end   kind              batch   group    objective channels
0      4     scan              b1      alpha    20x       GFP
4      6     scan              b3      alpha    20x       Cy5
6      8     gap:物镜切换          -       -        -         -
8      11    scan              b2      beta     40x       DAPI
状态证明 021bc5569ac36382 (gen=3, 已成像=0)
```

通道冲突（exit 10，输出冲突解释）：

```
$ node bin/micro.js book bX --group gamma --objective 20x --channels GFP,RFP --fields 2
{
  "error": "CHANNEL_CONFLICT",
  "message": "通道冲突: 批次 bX 的通道组合含互斥对 GFP <-> RFP",
  "details": { "id": "bX", "pair": ["GFP", "RFP"] }
}
exit=10
```

出具图像、维护迁移、更正追加：

```
$ node bin/micro.js scan --until 4
机时表 gen=4 clock=4
start  end   kind              batch   group    objective channels
0      4     imaged            b1      alpha    20x       GFP
4      6     scan              b3      alpha    20x       Cy5
6      8     gap:物镜切换          -       -        -         -
8      11    scan              b2      beta     40x       DAPI
状态证明 6b583e71370035fd (gen=4, 已成像=4)

$ node bin/micro.js maintain --start 6 --end 8
机时表 gen=5 clock=4
start  end   kind              batch   group    objective channels
0      4     imaged            b1      alpha    20x       GFP
4      6     scan              b3      alpha    20x       Cy5
6      8     maint             -       -        -         -
8      11    scan              b2      beta     40x       DAPI
状态证明 4b359685884b1959 (gen=5, 已成像=4)

$ node bin/micro.js correct b2 --delta 2
机时表 gen=6 clock=4
start  end   kind              batch   group    objective channels
0      4     imaged            b1      alpha    20x       GFP
4      6     scan              b3      alpha    20x       Cy5
6      8     maint             -       -        -         -
8      11    scan              b2      beta    40x       DAPI
11     13    scan              b2      beta    40x       DAPI
状态证明 1f0a82b8376d5b49 (gen=6, 已成像=4)
```

负视野与维护重叠（exit 10）：

```
$ node bin/micro.js correct b2 --delta -9
{ "error": "NEGATIVE_FIELDS", "message": "负视野: 批次 b2 视野数变为 -6", ... }
exit=10

$ node bin/micro.js maintain --start 6 --end 9
{ "error": "MAINTENANCE_OVERLAP", "message": "维护重叠: [6,9) 与已有窗口 [5,7)", ... }
exit=10
```

故障后回放（删除状态文件，从事件日志恢复，证明一致）：

```
$ rm microstate.json
$ node bin/micro.js replay
回放 7 个事件，状态证明 16519ca21c5c8ca7
$ node bin/micro.js table
机时表 gen=6 clock=10
start  end   kind              batch   group    objective channels
0      3     imaged            b1      alpha    20x       GFP
3      5     idle              -       -        -         -
5      7     maint             -       -        -         -
7      10    imaged            b2      beta     40x       DAPI
状态证明 16519ca21c5c8ca7
```

## 验收对照

| 验收 | 测试 |
| --- | --- |
| 1. n≤10 枚举最小完工对照 | `test/schedule.test.js` 验收1（子集 DP 对 Heap 枚举） |
| 2. 维护撤销后迁移不侵犯互斥 | `test/maintain.test.js` 验收2（`validateTimeline` 校验重叠/互斥/切换间隔） |
| 3. 同优先级同配额按批 ID | `test/schedule.test.js` 验收3 |
| 4. replay 从故障点恢复与连续运行一致 | `test/replay.test.js` 验收4（多故障点恢复后证明相等） |

## 结构

- `src/scheduler.js` 间隔模型、子集 DP 最优排序、障碍布局、枚举对照
- `src/policy.js` 配额 + 最久未服务 + 批 ID 裁决
- `src/ops.js` book/scan/correct/maintain/cancel 事务与代际回滚
- `src/cli.js` 命令行、事件日志、replay
- `src/table.js` 机时表渲染；`src/util.js` 状态证明
