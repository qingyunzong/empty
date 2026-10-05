# merge3 — 行号三方文档合并 CLI

以**行号**为基准做三方 diff / 合并的命令行工具。TypeScript 编写，仅使用
Node.js 内置库（`node:fs`、`node:util`、`node:test` 等），零运行时依赖。

## 合并规则

1. 分别计算 `diff(base, ours)` 与 `diff(base, theirs)`，得到以 base 行号
   （0 起始、半开区间）为坐标的修改 hunk。
2. 双方 hunk **不重叠即可合并**，包括直接相邻（一方区间终点 == 另一方起点）
   以及在对方修改区间边界上的插入。
3. 以下情况判为**冲突**：
   - 双方修改的行区间相交；
   - **同一点插入不同内容**（同点插入相同内容则只保留一份）；
   - 一方插入点严格落在另一方被替换的区间内部。
4. 冲突 hunk **保留原分支范围**：记录 base 原区间行号、`baseLines` 原文以及
   双方各自的替换内容，输出 diff3 风格标记：

   ```
   <<<<<<< ours
   <ours 的内容>
   ||||||| base
   <base 原文>
   =======
   <theirs 的内容>
   >>>>>>> theirs
   ```

## 可逆结果

每个 hunk（无论是否冲突）都记录自己的 base 行号区间与三方内容，
`--json` 输出的结果配合合并文本可以**无损还原**任意一方的输入：

```console
$ merge3 base.txt ours.txt theirs.txt --json result.json --out merged.txt
$ merge3 revert --result result.json --side base   --merged merged.txt
$ merge3 revert --result result.json --side ours   --merged merged.txt
$ merge3 revert --result result.json --side theirs --merged merged.txt
```

`revert` 会逐 hunk 校验合并文本与记录内容一致，被篡改时直接报错。
`--merged` 省略时从 stdin 读取合并文本。

## 短文档穷举对照

行数乘积 ≤ 1 000 000 的文档对走 `exhaustiveOps`：用完整代价表穷举每个
位置上 keep / delete / insert 三种**直接编辑组合**的代价，取最小编辑脚本；
更大的输入走 Myers O(ND) 算法。测试对短文档（字母表大小 2、长度 ≤ 4 的
全部 961 对组合）真正暴力枚举所有编辑脚本，验证 diff 输出的脚本合法且
代价最小，并在 500 组随机输入上交叉验证 Myers 与穷举路径结果一致。

## 用法

```
merge3 [merge] <base> <ours> <theirs> [--out FILE] [--json FILE]
       [--label-ours L] [--label-theirs L] [--label-base L]
merge3 revert --result FILE --side base|ours|theirs [--merged FILE] [--out FILE]
```

退出码：`0` 干净合并 / 成功，`1` 存在冲突，`2` 用法或 I/O 错误。
合并文本默认写到 stdout，`--out` 可改写到文件。

## 开发

```console
$ npm test    # tsc 编译 + node --test
$ npm run build
```

说明：环境无法联网安装 `@types/node`，`types/node-shims.d.ts` 自带了所用
Node 内置模块的最小类型声明。实际测试结果见 [RESULTS.md](RESULTS.md)。
