# archive-repair

野外设备带回可能损坏的分块归档，本工具判断哪些分块可信、生成确定性修复计划并原子应用。Node.js 22，仅标准库，单机离线。

## 归档格式

```
<archive>/
  manifest.json             # { version, chunks: [{ index, file, length, adler32, sha256 }] }
  chunks/chunk-000000.bin   # 块目录
```

- 块长表：manifest 中每块的 `length`
- 滚动校验：Adler-32（弱校验，快速预检）
- 强 hash：SHA-256（最终裁决）

## 损坏判定

块缺失或强 hash 不一致即判损坏。弱校验命中**不能**证明可信：弱校验（Adler-32）碰撞但强 hash 失败仍判损坏（`reason: weak-collision`）；弱校验不一致但强 hash 通过仍可信。

## 命令

```sh
node cli.js inspect <archiveDir>                          # 逐块状态报告
node cli.js planRepair <archiveDir> <knownGoodDir> <maxBytes>
node cli.js applyPlan <archiveDir> <planFile>
node cli.js verify <archiveDir>                           # 有损坏时退出码 1
```

### planRepair

- 输出确定性 JSON：`repairs` 按块号升序，源路径取字典序最小候选。
- knownGood 中强 hash 相同的块可复用；多个来源声称同 hash 但实际内容不同 → `ERR_SOURCE`。
- 容量预算：只选能完成**连续前缀**（从第一个损坏块起不间断）的方案；某块超预算或无可用源即截断，绝不部分跳过。`maxBytes` 非非负整数 → `ERR_BUDGET`。
- 无损坏时 `repairs` 为空、`totalBytes` 为 0。

### applyPlan

- 应用前校验计划与 manifest 一致并复核所有源的强 hash（不一致 → `ERR_CRC` / `ERR_SOURCE`），此阶段失败不触碰归档。
- 提交阶段先将新块写入临时目录，再逐块备份-替换；中途任何失败回滚全部已替换块，归档保持字节级不变，报 `ERR_IO`。
- 测试可用 `applyPlan(dir, plan, { onBeforeCommit(i) })` 注入失败。

## 错误

错误以 JSON 写 stderr，退出码 1：`{"error":"ERR_BUDGET|ERR_SOURCE|ERR_CRC|ERR_IO","message":"..."}`

- `ERR_BUDGET`：maxBytes 非法
- `ERR_SOURCE`：候选源冲突或源内容与计划 hash 不符
- `ERR_CRC`：manifest 损坏/格式非法、计划与归档不匹配
- `ERR_IO`：文件读写失败（含 applyPlan 中途失败，已回滚）

## 测试

```sh
node --test
```
