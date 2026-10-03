# plan-sync

离线双工位排程同步库与 CLI。仅依赖 Node.js 22 标准库，测试使用 `node:test`。

## 模型

- **变更日志** `log.jsonl`：JSONL 追加捕获 `insert` / `move` / `cancel`，每条携带向量时钟与哈希链。
- **快照 + 清单**：`snapshot.json`（经 `snapshot.tmp.json` 写入、fsync、rename）+ `manifest.json`（tmp+rename+fsync 提交），清单记录已提交日志前缀哈希与状态哈希。
- **恢复** `resume`：清单缺失/快照哈希不符/日志前缀哈希不符 → 退出 4；丢弃 `snapshot.tmp.json` 半快照；截断未 fsync 的撕裂日志尾；重放清单之后的日志条目。
- **约束**：工序先后（同机顺序不得倒置前序链）、设备能力、交期惩罚预算（加权误工总和 ≤ budget）。违规 → 退出 2。
- **冲突合并**：确定性规则——`cancel` > `move` > `insert`，同类按 `(node, seq)` 字典序大者胜；败方进入 `pending`（未决，不视为不可满足），后续支配性变更可清除。存在 pending → 退出 3。
- **证书** `export-cert`：规范化（键排序）JSON，含时钟、日志/状态哈希、成本、pending 与排程，跨终端、跨同步顺序可复现。

## CLI

```
plan-sync init        --dir D --node N --plan @plan.json
plan-sync apply       --dir D --change '<json>' | @file | -
plan-sync sync        --a DIR_A --b DIR_B
plan-sync resume      --dir D
plan-sync verify      --dir D
plan-sync export-cert --dir D [--out file]
```

错误输出为 stderr JSON：`{"error":{"code","message","details"}}`。
退出码：`0` 成功，`1` 用法/内部错误，`2` 校验失败，`3` 冲突未决，`4` 恢复失败，`86` 故障注入崩溃。

## 故障注入

环境变量 `PLAN_SYNC_FAULT` 取值：

- `before-append`：日志 append 前崩溃 → 恢复至上一致点；
- `after-append-no-fsync`：append 后未 fsync（撕裂尾行）→ 截断并回到上一致点；
- `before-rename`：快照临时文件 rename 前崩溃（半截 tmp）→ 丢弃半快照并重放日志；
- `after-manifest`：manifest 提交后崩溃 → 恢复并报告已提交状态。

## 测试

```
node --test
```

包含：双向收敛、四种故障点注入恢复、同工序并发移动的可复现证书、n≤8 独立枚举最优成本对照。
