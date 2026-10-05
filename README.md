# doc-merge

基于行号的三方文档合并 CLI。TypeScript 编写，仅使用 Node.js 内置模块
（`node:fs` / `node:util` / `node:test` / `node:assert` / `node:child_process` 等），
无任何 npm 运行时依赖。

## 构建与测试

```sh
npm test        # tsc 编译到 dist/ 后用 node:test 运行全部测试
npm run build   # 仅编译
```

## 使用

```sh
node dist/src/cli.js merge <base> <ours> <theirs> [--labels O,B,T] [--json]
node dist/src/cli.js unmerge <merged> [--json]
```

- `merge`：合并结果写到 stdout；无冲突退出码 0，有冲突退出码 1（冲突数写到 stderr）。
  `--json` 输出完整可逆的 `MergeResult`（含每个变更/冲突段的三方原始行范围）。
- `unmerge`：从带冲突标记的合并文件还原 base / ours / theirs 三个文档，
  默认写出 `<file>.{base,ours,theirs}`，`--json` 时打印 JSON。

## 合并规则

1. 分别对 base→ours、base→theirs 做行级 diff，得到以 base 行号为坐标的 hunk。
2. 两侧 hunk **相邻但不重叠**（一个的终点恰为另一个的起点，含在对方 hunk
   边界处的插入）→ 干净合并。
3. hunk 重叠 → 若两侧对该 base 范围的修改结果完全相同则取其一，否则冲突。
   **同点插入不同内容**视为重叠（冲突）；同点插入相同内容干净合并。
4. 冲突以 diff3 风格标记输出，**保留原分支范围**：

   ```
   <<<<<<< ours
   <ours 对该范围的替换行>
   ||||||| base
   <base 原始行范围>
   =======
   <theirs 对该范围的替换行>
   >>>>>>> theirs
   ```

## 可逆结果

`merge3()` 返回的 `MergeResult.segments` 对**每一个**变更区域都记录了
`baseLines / oursLines / theirsLines` 三方原始范围（`change` 段为干净应用的
变更，`conflict` 段为冲突），因此 `reconstruct(result)` 可以完整还原三个
输入文档。`unmerge(text)` 则从渲染出的冲突标记文本还原三方；当文档中所有
差异区域都是冲突时（无干净应用的变更段），文本本身就足以完整还原。

## 短行序列穷举 diff

base 行数 ≤ 12（`EXHAUSTIVE_LIMIT`）时，`src/diff.ts` 直接**穷举所有编辑
组合**：按删除行数 d = 0,1,2,… 枚举 base 行的所有删除子集，若保留行是目标
序列的子序列，则插入操作被唯一确定；总编辑数 = d + (|b| − |a| + d) 随 d
严格递增，第一个命中的组合即最小编辑脚本。更长的输入回退到 Myers O(ND)。
测试中对 500 组随机短文档交叉验证两种实现：编辑数一致且均能正确还原目标。

## 实际测试结果

`npm test`（2026-10-06 07:29 CST，Node v22.22.1，tsc 7.0.2）：

```
> tsc -p tsconfig.json && node --test dist/test/*.test.js

ok 1 - dist/test/cli.test.js     #  6 个测试全部通过
ok 2 - dist/test/diff.test.js    # 12 个测试全部通过
ok 3 - dist/test/merge.test.js   # 16 个测试全部通过
# tests 3
# pass 3
# fail 0
```

逐文件 TAP 汇总：`cli.test.js` 6/6，`diff.test.js` 12/12，
`merge.test.js` 16/16，合计 **34/34 通过，0 失败**。

覆盖要点：

- diff：插入/删除/替换/空文档、最小编辑数、穷举 vs Myers 随机交叉验证、长文档；
- merge：相邻不重叠合并、同点插入冲突、同点同内容合并、重叠冲突保留 base
  范围、双侧相同修改、边界插入、多空冲突、自定义标签、10 组用例的可逆性矩阵；
- cli：干净合并退出码 0、冲突退出码 1 及标记输出、`--json` 可逆结果、
  `--labels`、`unmerge` 往返还原、用法错误退出码 2。

## 已知限制

- 冲突标记解析假定文档本身不含以 `<<<<<<< ` 等标记开头的行。
- 干净合并的纯文本（同 git）不保留各侧原始行；需要可逆性时请使用
  `--json` 的结构化结果或保留输入文件。
- 本环境的 Node 构建无法通过管道捕获子 node 进程的 stdout，CLI 测试改经
  `sh -c` 重定向到临时文件捕获（见 `test/cli.test.ts` 注释）。
