# ratiograph

变量间正有理数比例约束图库。边 `(u, v, r)` 表示约束 `x_u / x_v = r`（`r` 为正有理数，精确使用 `math/big.Rat`）。

## 模型

- **全图势能传播核验**：每次批量操作后，从每个连通组件任选根赋势能 1，沿边 `x_w = x_v / r` BFS 传播；遇到已赋值邻居即核对，冲突时沿 BFS 树路径加触发边构造**环乘积证书**（沿环比例乘积 ≠ 1）。
- **最简正整数比例向量**：组件内势能乘分母最小公倍数化为整数，再除以整体最大公约数。
- **原子批增删**：整批操作先在克隆图上应用并全图核验；任一操作非法或结果不一致则整体回滚，原图不变。

## API

```go
g := ratiograph.New()
sol, cert, err := g.Apply(
    ratiograph.AddOp(ratiograph.NewEdge("a", "b", 1, 2)), // x_a/x_b = 1/2
    ratiograph.AddOp(ratiograph.NewEdge("b", "c", 2, 3)),
    ratiograph.RemoveOp("a", "b"),
)
// sol.Components[i]: 第 i 个连通组件的最简正整数比例向量（Nodes 与 Values 对齐）
// cert: 不一致时的环乘积证书，cert.Verify() 可独立校验
// err: 非法操作（重复增边、删不存在边、非正比例等）
```

- `Graph.Solve()`：对当前图单独执行核验。
- `Solution.Satisfies(g)`：用解回代全图每条边复核。
- `Certificate.Verify()`：校验证书闭环、比例为正、乘积自洽且 ≠ 1。

## 测试

```sh
go test ./...
```
