# depsolve

离线依赖版本求解 CLI（仅使用 Go 标准库）。

输入至多 16 个包、每包至多 4 个版本，支持依赖区间与互斥（conflicts）特性；
每个包至多选择一个版本（选择一致）。求解目标按字典序：

1. **变更最少** — 与现有 lock 相比发生变化的包数最少（新装未锁定包、
   移除已锁定包、版本与锁不一致各计 1 次变更）；
2. **版本最高** — 在变更数最小的解中，按输入包顺序字典序取最高版本
   （已安装优于未安装）。

输出为**可行证书**（选定版本集合 + 变更数，可由 `solver.Verify` 独立校验）
或**最小冲突约束集**（删除极小化的不可满足约束子集）。
小实例可用 `-brute` 对全枚举结果进行核对。

## 用法

```sh
go build -o depsolve .
./depsolve -input instance.json        # 或省略 -input 从 stdin 读取
./depsolve -input instance.json -brute # 附带全枚举交叉核对
```

退出码：求解成功（可行或不可行）为 0；输入/内部错误为 1。

## 输入格式

```json
{
  "packages": [
    {"name": "app", "versions": [
      {"version": "1.0.0", "depends": [{"name": "lib", "range": ">=1.0.0 <2.0.0"}]},
      {"version": "2.0.0", "depends": [{"name": "lib", "range": ">=2.0.0"}],
                            "conflicts": [{"name": "legacy", "range": "*"}]}
    ]},
    {"name": "lib", "versions": [{"version": "1.0.0"}, {"version": "2.0.0"}]}
  ],
  "roots": [{"name": "app", "range": ">=1.0.0"}],
  "lock": {"app": "1.0.0", "lib": "1.0.0"}
}
```

- `range`：空白或逗号分隔的比较子合取，支持 `>= <= > < = !=` 与 `*`；
  裸版本号等价于 `=`。版本为点分数字（如 `1.2.3`）。
- `roots`：必须安装的包及区间；只有从根可达的包才会被安装。
- `lock`：可选，现有锁文件（包名 -> 版本）。

## 输出格式

可行：

```json
{"status": "feasible", "solution": {"app": "2.0.0", "lib": "2.0.0"}, "changes": 2}
```

不可行（最小冲突约束集）：

```json
{"status": "infeasible", "changes": 0,
 "conflict": ["root: a *", "depends: a@1.0.0 -> b >=2.0.0"]}
```

## 实现要点

- `solver/sat.go`：CDCL 求解器（二元监视、1-UIP 学习、按包决策启发式），
  变更基数约束通过“界限冲突”参与学习。
- `solver/model.go`：SAT 编码 — 每包至多一版、依赖/互斥/根约束子句，
  以及 lock 变更跟踪变量；依赖同时生成二元禁用子句以加强传播。
- `solver/solve.go`：两阶段优化（先最小化变更数，再字典序最大化版本）、
  删除极小化冲突核、证书校验。
- `solver/brute.go`：独立的全枚举求解器与 `CrossCheck` 交叉核对。

## 测试

```sh
go test ./...
```

涵盖版本/区间解析、锁偏好、最小变更、互斥、冲突核最小性、规模上限、
16×4 满规模实例，以及 300 个随机小实例对全枚举的交叉核对
（`TestRandomCrossCheck`）。
