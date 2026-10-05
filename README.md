# essplan — 储能充放电调度 CLI

在至多 12 个时段的规划区间内，最小化购电总费用。电量落在整数网格点上，
充/放电效率为有理数，所有费用用 `math/big.Rat` 精确计算。同一时段不会
同时充电和放电（动作空间在构造上互斥）。

## 模型

- 每时段 `t`：整数需求 `demand`、电价 `price`、充电上限 `charge_limit`、
  放电上限 `discharge_limit`（充/放上限以电池侧能量计）。
- 电池：整数容量 `capacity`、初始电量 `initial_soc`、末段最低电量
  `final_soc_min`。
- 效率：充电效率 `eta_c = num/den`（电网→电池），放电效率
  `eta_d = num/den`（电池→电网），均为正有理数。
- 时段电网净购能（可为负，负值表示向电网售电）：
  `grid = demand + charge/eta_c - discharge*eta_d`
- 时段费用：`price * grid`，目标为总费用最小。

## 求解方法

- 主求解器：在整数 SOC 格点 `0..capacity` 上做动态规划，逐时段转移，
  费用为精确有理数，输出逐段能量证书（动作、充/放电量、SOC、电网净能、
  费用），并自动重放校验（`Verify`）。
- 小规模核对：`BruteForce` 枚举全部动作序列得到精确最优值，测试中与
  DP 结果逐一比对（300 个随机小实例 + 一个 12 时段实例）。

## 用法

```sh
go build -o essplan .
./essplan -in example.json          # 求解并输出证书
./essplan -in example.json -brute   # 附加全枚举核对（小规模）
cat example.json | ./essplan        # 也可从 stdin 读入
```

输入/输出均为 JSON，字段见 `example.json` 与 `model.go`、`solve.go` 的
结构体定义。输出中的 `grid_energy`、`cost`、`total_cost` 为精确有理数
字符串（如 `"8197/90"`）。

## 测试

```sh
go test ./...
```

实际运行结果见 `TEST_RESULTS.md`。
