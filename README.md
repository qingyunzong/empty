# arc-repair

野外设备归档的完整性检查与修复工具。仅依赖 Node.js 22 标准库，单机离线可用。

## 归档格式

```
arc/
  manifest.json        # 块目录：块长表 + 滚动校验(Adler-32) + 强hash(SHA-256)
  blocks/000000.bin    # 块数据，按块号命名
  blocks/000001.bin
```

`manifest.json`：

```json
{
  "version": 1,
  "blockCount": 2,
  "blocks": [
    { "index": 0, "length": 65536, "adler32": "…", "sha256": "…" }
  ]
}
```

## 损坏判定

块只有在 **弱校验(Adler-32)失败 且 强hash(SHA-256)失败** 时才计为损坏：

- 弱校验失败但强hash有效 → 弱校验误报，不算损坏；
- 强hash失败但弱校验仍命中 → 按规则不判损坏；
- 块文件缺失 → 两级校验都无法通过，计为损坏。

## 修复计划（planRepair）

`planRepair(arcDir, knownGoodDir, maxBytes)`：

- `knownGoodDir` 可以是单个归档，也可以是包含多个候选源归档的目录；
- 候选源清单中同块号、同强hash的块可复用；多个来源声明同一 hash 但实际内容不同 → `ERR_SOURCE`；
- 输出确定性 JSON：repairs 按块号升序，源路径按字典序选取；
- 预算 `maxBytes` 超限时只取能完成的**连续前缀**（按损坏块号排序），其余记入 `skipped`（原因：`budget` / `no-source` / `prefix`）；
- 无损坏时输出空计划（`repairs: []`）。

## 应用计划（applyPlan）

- 应用前校验计划（排序、预算、与归档 manifest 一致）；
- 全部替换块先写临时文件并 fsync，再逐个 rename 提交；
- 任意阶段失败都回滚：原归档保持字节级不变，不残留临时文件（禁止部分应用）。

## CLI

```sh
node cli.js inspect <arc>                      # 逐块报告（stdout JSON）
node cli.js verify <arc>                       # ok/damaged，损坏时退出码 1
node cli.js planRepair <arc> <good> <maxBytes> # 修复计划（stdout JSON）
node cli.js applyPlan <arc> <plan.json>        # 原子应用计划
node cli.js create <dir> <blockSize>           # 从 stdin 字节流构建归档
```

错误一律输出到 stderr，JSON 格式：`{"error":{"code":"…","message":"…"}}`，退出码 2。
错误码：`ERR_BUDGET`（预算非法/计划超预算）、`ERR_SOURCE`（源冲突或源内容不符）、
`ERR_CRC`（manifest/计划校验字段非法或不匹配）、`ERR_IO`（读写失败）。

## 测试

```sh
node --test
```
