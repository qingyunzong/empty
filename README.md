# alertcfg — 离线报警层级配置版本工具

Node.js 22，仅标准库，测试使用 `node:test`。

## 数据模型

仓库文件（如 `r.json`）：

```json
{
  "base": { "thresholds": {"temp": 50}, "children": { "site": { "thresholds": {}, "children": {} } } },
  "commits": [
    { "sealed": false, "patch": { "set": { "site": {"temp": 60} } } }
  ]
}
```

- 设备树每个节点含 `thresholds`（覆盖值）与 `children`；子节点未覆盖的键继承最近祖先。
- 节点路径：`""` 为根，`"site/rack"` 为后代。
- 补丁（结构化）：`set`（增/改覆盖值）、`unset`（删覆盖键）、`addNodes`、`deleteNodes`。
- 提交哈希 = sha256(父哈希 + 补丁 + stateHash + sealed) 的链式哈希；`stateHash` 为整树规范化 JSON 的 sha256。

## CLI

```sh
node index.js squash --repo r.json --from h --to h --out n.json
node index.js merge  --repo r.json --base h --left lp.json --right rp.json --out n.json
node index.js log    --repo r.json
```

退出码：成功 `0`；合并冲突 `1`；路径/区间错误（未知哈希、区间倒置、跨越 sealed、补丁应用失败）`2`。

## 三方合并

- 不同节点路径的修改自动合并；
- 同一路径同一覆盖键两侧值不同 → 冲突（一侧删键另一侧改键同样冲突）；
- 一侧 `deleteNodes` 某节点、另一侧在其子树内改配置 → 结构冲突。

## squash

- 将 `[from, to]` 区间压缩为单个结构化补丁（= 区间前后状态的 diff）；
- 区间内不得含 sealed 提交（sealed 边界不可跨越）；
- 压缩在临时历史上完成并校验：压缩点及末端的所有叶子生效阈值与 `stateHash` 必须与原历史完全一致，失败则不写输出、原历史保持不变；
- 输出含 `squashMap`：区间内旧哈希 → 新提交哈希，区间后续提交哈希随父链重算并一并映射。

## 测试

```sh
node --test
```

覆盖：父子不相交覆盖合并与继承、删父/改子结构冲突、压缩后生效配置/根哈希/旧→新映射、以及 ≤3 层 ≤3 键全部覆盖子集与独立继承实现对照。
