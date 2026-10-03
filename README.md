# branch-merge

单机离线、零依赖（仅 Node.js 22 标准库）的字段级三方合并库与 CLI。

## 数据模型

- 基准记录 `base`: `{ "value", "quality", "reviewed" }`
- 每个分支是一组编辑 `{ author, level, clock, field, old, new }`：
  - `clock` 为向量时间戳，`level` 为来源等级，`old` 为字段级旧值。

## 合并规则（按字段）

1. 一侧未修改 → 取另一侧；两侧相同修改 → 合并且不冲突。
2. 编辑的 `old` 与基准不符 → 视为过时写入（stale），该侧自动放弃。
3. 双侧不同修改时按确定性自动策略裁决：来源等级高者胜 → 同等级向量时间戳新者胜 →
   并发时间戳按作者字典序。
4. 无法自动决定时生成可复核冲突证书（含双方编辑、基准值、原因、SHA-256 指纹）：
   - 完全相同的向量时间戳（`same-timestamp`）
   - 双侧把 `reviewed` 置为不同布尔值（`reviewed-divergence`，无视等级）

## 用法

```sh
node cli.js base.json left.json right.json [outdir]
```

- 成功：写出 `merged.json` 与 `decision-log.json`，退出码 0。
- 冲突：写出 `conflicts.json`（证书）与 `decision-log.json`，退出码 2。

## 测试

```sh
node --test
```

覆盖自动胜出（等级/时间戳/作者序）、同时间冲突、reviewed 分歧冲突、过时写入，
并对单字段枚举两分支全部有限取值组合（value 3×4×4、reviewed 2×3×3），
在测试内独立计算期望决策后比对。真实结果见 `test-result.txt`。
