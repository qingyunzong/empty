# depsolve — 离线依赖求解 CLI

读取 JSON 问题描述（文件参数或标准输入），在 **至多 16 个包、每包至多 4 个版本**
的规模下求解版本选择问题，仅使用 Go 标准库。

## 输入格式

```json
{
  "packages":     [{"name": "a", "versions": ["1.0.0", "2.0.0"]}],
  "dependencies": [{"from": "a", "from_version": "2.0.0", "to": "b", "range": ">=1.0.0 <2.0.0"}],
  "conflicts":    [{"package": "a", "version": "1.0.0", "with": "c", "with_range": ">=3.0.0"}],
  "roots":        [{"name": "a", "range": ">=1.0.0"}],
  "lock":         {"a": "1.0.0"}
}
```

- 区间语法：逗号/空格分隔的比较子（`< <= > >= = == !=`），裸版本号表示相等，`*` 或空串匹配任意版本。
- 依赖：`from` 选中 `from_version` 时，`to` 的选中版本必须落在 `range` 内。
- 互斥：`package` 选中 `version` 时，`with` 不得选中 `with_range` 内的版本。
- 每个声明的包必须恰好选中一个版本（版本选择一致性）。

## 求解目标

1. **锁变更最少**：与 `lock` 中版本不一致的包数量最小化（未上锁的包不计）；
2. **版本最高**：在上述最优解中，按包名字典序取版本向量最高者。

## 输出

- 可行：`status=feasible`，`solution` 即为可行证书（可由 `solver.Verify` 独立校验），`changes` 为锁变更数，退出码 0；
- 不可行：`status=infeasible`，`conflict` 为**最小冲突约束集**（基于删除法的 MUS：去掉其中任意一条即可恢复可行），退出码 1。

## 用法

```sh
go build -o depsolve .
./depsolve -file examples/feasible.json          # 或 cat input.json | ./depsolve
./depsolve -file examples/infeasible.json -brute # -brute: 小实例全枚举交叉核对
```

## 实现

- `solver/solve.go`：分支限界求解器。包按名字序、版本按"锁版本优先，其余降序"展开；
  前向检查剪枝（未赋值目标包须保留可用版本），目标函数字典序分支限界。
- `solver/brute.go`：全枚举核对器（组合数上限 4×10⁶），供小实例交叉验证。
- `solver/mus.go`：删除法最小不可满足子集提取。
- `solver/solver_test.go`：500 个随机小实例上求解器与全枚举结果逐一比对，
  并对随机不可行实例验证 MUS 的不可满足性与删除极小性。

## 测试

```sh
go test ./...
```
