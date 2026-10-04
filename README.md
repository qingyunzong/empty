# quorumcli

仲裁集求解 CLI（仅使用 Go 标准库）。包含两个求解器：

- `quorum`：最小成本合法仲裁集（总权严格过半 + 至少两个故障域），至多 22 个候选投票节点。
- `pair`：最小成本读/写仲裁集对，任意允许单故障后两者仍相交且各自满足权重与域数约束，至多 18 个候选投票节点。

## 构建与运行

```sh
go build -o quorumcli ./cmd/quorumcli
./quorumcli quorum -f examples/quorum.json
./quorumcli pair   -f examples/pair.json
./quorumcli quorum -f examples/quorum.json  > cert.json
./quorumcli verify-quorum -f examples/quorum.json -cert cert.json
./quorumcli pair   -f examples/pair.json    > paircert.json
./quorumcli verify-pair   -f examples/pair.json   -cert paircert.json
```

输入默认从 stdin 读取（省略 `-f` 时）。

## 输入格式

```json
{
  "nodes": [
    {"id": "a", "weight": 5, "cost": 4, "domain": "d1", "voter": true}
  ],
  "allowed_faults": ["d1", "d2"]
}
```

- `voter: true` 表示节点属于候选投票集；只有候选投票节点可进入仲裁集，也只有它们计入总权重。
- `cost` 可省略，默认为 1（即最小化节点数）。
- `allowed_faults` 仅用于 `pair`：允许的单一故障场景（每个条目为一个故障域）。缺省时，候选投票节点出现的每个故障域都视为一个允许的单故障。

## 语义约定

- 合法仲裁集：成员权重之和严格大于候选投票集总权重的一半（`2*quorum_weight > total_weight`），且覆盖至少 2 个不同故障域。
- 单故障：一个故障域整体失效，域内节点从仲裁集中移除。
- 读/写对：R ≠ W（两个不同的集合），目标为 `cost(R) + cost(W)` 最小。要求对每个允许的单故障 F：R\F 与 W\F 各自仍满足权重与域数约束，且 `(R∩W)\F` 非空。
- 两个求解器都是精确求解：`quorum` 用分支限界，`pair` 先筛出弹性仲裁集再按成本和做最佳优先搜索；输出中 `lower_bound == upper_bound == 最优值`。

## 输出证书

- `quorum` 输出权重证书（仲裁集权重、总权重、判定规则）与域证书（覆盖的故障域列表、计数、最小要求）。
- `pair` 输出每个故障场景的交集证书：读/写各自幸存权重与幸存域、交集成员列表，以及最优上下界。
- `verify-quorum` / `verify-pair` 独立重算证书中的每一项声明（含重新求解验证最优性），输出 `{"valid": true}` 或报错退出。

## 测试

小规模子集枚举验收：测试中用独立的暴力子集枚举 oracle（`bruteForceQuorum` / `bruteForcePair`）在数百个随机小实例上对比求解器结果，并验证证书与防篡改。

实际运行结果（Go 1.27.1，linux/amd64）：

```
$ go test ./...
?   	quorumcli/cmd/quorumcli	[no test files]
ok  	quorumcli/quorum	0.024s
```
