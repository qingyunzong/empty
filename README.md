# alert-hierarchy-vcs

离线报警层级配置版本工具。Node.js 22，仅标准库，测试使用 `node:test`。

## 数据模型

仓库文件（如 `r.json`）：

```json
{
  "base": { "thresholds": {"temp": 10}, "children": { "a": { "thresholds": {}, "children": {} } } },
  "commits": [
    { "hash": "g", "parents": [], "sealed": true,  "patch": { "set": {"/a": {"temp": 5}} }, "stateHash": "..." }
  ],
  "head": "g"
}
```

- 配置为设备树，每个节点可含 `thresholds`；子节点未覆盖的键继承最近祖先。
- 补丁按节点路径（`/a/b`，根为 `/`）增删改覆盖值：
  - `set`: `{path: {key: value}}` 设置/修改覆盖
  - `unset`: `{path: [key]}` 删除覆盖（回落到继承值）
  - `delete`: `[path]` 删除节点子树
- `stateHash` 为整棵树规范 JSON 的 SHA-256。

## 三方合并

`node index.js merge --repo r.json --base h --left h --right h --out n.json`

- 不同节点路径的修改自动合并。
- 同一路径同一覆盖键两侧取不同值 → 冲突（退出码 1）。
- 一侧删除某节点、另一侧在其子树内修改配置 → 结构冲突（退出码 1）。

## 压缩（squash）

`node index.js squash --repo r.json --from h --to h --out n.json`

- 把 `(from, to]` 区间内的非 sealed 提交压缩成一个结构化补丁提交。
- sealed 边界不可跨越；区间内出现 sealed 提交报错。
- 压缩在临时历史上进行并验证：整棵树所有叶子的生效阈值逐叶相同、
  区间末端与 head 的 `stateHash` 完全一致；失败则保持原历史，不写输出。
- 输出仓库含 `mapping`：旧提交哈希 → 新提交哈希（区间内提交映射到压缩提交）。

## 退出码

- `0` 成功
- `1` 合并冲突
- `2` 路径/区间/校验错误

## 测试

```sh
node --test
```
