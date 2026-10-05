# testmatrix

成对（pairwise）测试矩阵生成 CLI：按有限维选值，支持显式禁组合与前置条件，
用最少的合法配置覆盖全部合法二元组（至多 30 个候选配置），并输出可独立
校验的合法性与覆盖证书。仅使用 Go 标准库。

## 用法

```sh
go build -o testmatrix .
./testmatrix solve  -spec example-spec.json -cert cert.json   # 求解并输出证书
./testmatrix verify -spec example-spec.json -cert cert.json   # 独立校验证书
```

参数：

- `-max`：候选配置上限，默认 30。
- `-exact-limit`：小集全子集枚举核对的合法配置宇宙上限，默认 20（0 关闭）。
- `-spec -` 从 stdin 读取规格。

## 规格格式

```json
{
  "dimensions": [{"name": "os", "values": ["linux", "win", "mac"]}],
  "forbidden": [{"os": "win", "browser": "safari"}],
  "preconditions": [{"when": {"db": "mysql"}, "require": {"os": "linux"}}]
}
```

- `forbidden`：任何合法配置不得包含的局部赋值。
- `preconditions`：蕴含约束——配置匹配 `when` 时必须同时匹配 `require`。

## 证书内容

- `configs`：每个配置的完整赋值及合法性断言。
- `coverage`：每个合法二元组及其覆盖配置编号（覆盖证书）。
- `uncoverablePairs`：不可覆盖对单列——由完备回溯搜索证明无任何合法
  配置可同时包含两端点。
- `uncoveredPairs`：合法但因配置上限未覆盖的对（仅在上限用尽时合法）。
- `minimality`：小集核对结果——枚举全部合法配置，按子集大小递增做全
  子集枚举，证明解的规模等于最优值。

`verify` 子命令独立重算全部断言（合法性、覆盖归属、三分划完备性、
最小性），任何篡改都会导致非零退出。

## 测试

```sh
go test ./...
```
