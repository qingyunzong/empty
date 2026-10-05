# 核验库（result-verifier）

对三类输入证据——**结果清单**（manifest.json）、**轨迹**（trajectories.json）、**文件摘要**（file-summaries.json）——逐项核验 **运行ID、题面摘要、阶段来源** 的一致性。

- 仅使用 Node.js 内置模块（`node:fs` / `node:path` / `node:test` / `node:assert`），零运行时依赖
- TypeScript 编写，`tsc` 编译后运行
- 缺失证据 → 标 **未知**；来源取值矛盾 → 标 **冲突**，并输出**最小冲突对**及**引用范围**（文件 + JSON 指针 + 行列范围）

## 使用

```bash
npm test                          # 编译并运行全部测试
npm run verify -- fixtures/baseline   # 对指定目录执行核验
# 或：node dist/src/cli.js <输入目录>
```

退出码：`0` 全部一致；`1` 存在冲突；`2` 存在未知/孤儿运行或输入非法。

## 输入格式

- `manifest.json`：`{ "items": [{ "itemId", "runId", "problemSummary", "stageSources": [...] }] }`
- `trajectories.json`：`{ "runs": [{ "runId", "itemId", "problemSummary", "stages": [{ "name", "source" }] }] }`
- `file-summaries.json`：`{ "runs": [{ "runId", "itemId", "problemSummary", "files": [{ "path", "sha256", "bytes" }] }] }`

## 核验规则

| 检查项 | 比对内容 |
| --- | --- |
| 运行ID | 清单条目与轨迹、文件摘要的 `(runId, itemId)` 链式一致 |
| 题面摘要 | 三方 `problemSummary` 归一化后一致 |
| 阶段来源 | 清单 `stageSources` 序列与轨迹实际阶段 `source` 序列一致 |

- 任一所需来源缺失（如轨迹中无该 runId）→ 该检查项标 **未知**，不判冲突
- 轨迹/文件摘要中存在但清单未登记的运行 → **孤儿运行**，标 **未知**
- 取值分多组 → **冲突**；最小冲突对 = 每个取值组取一个代表两两组合（3 方时最多 3 对），恰好覆盖全部分歧且不可再减
- 引用范围由自带的位置感知 JSON 解析器（`src/jsonpos.ts`）生成，可按行列偏移精确切回原文

## 结构

- `src/jsonpos.ts` — 带引用范围（JSON 指针 → 行列/偏移）的 JSON 解析器
- `src/loader.ts` — 输入加载与结构校验
- `src/verify.ts` — 核心核验：`evaluateField`（一致/未知/冲突 + 最小冲突对）、`verify`、孤儿检测
- `src/report.ts` / `src/cli.ts` — 报告格式化与命令行入口
- `fixtures/baseline/` — 三方一致的基准数据
- `tests/verify.test.ts` — 单元 + 验收测试

## 验收与实测结果

`npm test`（Node v22.22.1，tsc 7.0.2）实际运行结果：**15 项测试全部通过**。

```
ok 1  - 基准夹具：全部检查一致，无孤儿运行
ok 2  - evaluateField：取值全同 -> 一致
ok 3  - evaluateField：缺失证据 -> 未知（不判冲突）
ok 4  - evaluateField：2+1 分歧 -> 恰 1 对最小冲突对
ok 5  - evaluateField：三方各异 -> 恰 3 对最小冲突对（C(3,2)）
ok 6  - 篡改轨迹题面摘要 -> 冲突，冲突对引用被篡改文件且引用范围可定位原文
ok 7  - 三方题面摘要各异 -> 3 对最小冲突对
ok 8  - 篡改轨迹阶段来源 -> 阶段来源冲突
ok 9  - 篡改文件摘要 itemId -> 运行ID 链式冲突
ok 10 - 验收·随机篡改：60 轮随机篡改均被判为冲突且定位到被篡改文件
ok 11 - 验收·删项：删除清单条目 -> 对应运行成孤儿（未知），不产生冲突
ok 12 - 验收·删项：删除轨迹运行 -> 该运行 3 项检查全部未知，不产生冲突
ok 13 - 验收·删项：删除文件摘要运行 -> 运行ID/题面摘要未知，阶段来源仍一致
ok 14 - 验收·随机删项：30 轮随机删除均标未知且零冲突
ok 15 - 引用范围：指针与行列偏移可精确切出原始 JSON 片段
# tests 15  # pass 15  # fail 0
```

- **随机篡改验收**（测试 10）：固定种子 RNG，60 轮随机篡改（题面摘要/阶段来源，覆盖三个文件），每轮均检出冲突且最小冲突对引用到被篡改文件与对应 runId
- **删项验收**（测试 11–14）：删除清单条目 → 孤儿运行标未知；删除轨迹/文件摘要运行 → 对应检查项标未知；30 轮随机删项零误报冲突
- CLI 实测：`fixtures/baseline` 全一致（退出码 0）；篡改副本检出 2 处冲突 + 2 个孤儿运行（退出码 1）
