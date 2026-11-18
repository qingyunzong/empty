# formal — Go BGP 选路库

供路由栈决策路径调用的确定性 BGP 最佳路由选择库（仅依赖标准库，包名 `formal`）。

## 决策顺序

`CompareRoutes` / `RIB.Best` 严格按以下公开决胜顺序比较，命中即返回对应 `DecisionStep`：

1. `LOCAL_PREF`：越大越优；缺失按默认值 `DefaultLocalPref = 100` 处理。
2. 本地起源：`PeerLocal` 路由优先于任何邻居学到的路由。
3. `AS_PATH` 长度：越短越优；`AS_SEQUENCE` 逐 AS 计数，非空 `AS_SET` 计 1，空段计 0。
4. `ORIGIN`：`IGP < EGP < INCOMPLETE`；缺失视为 `IGP`，越界编码视为 `INCOMPLETE`。
5. `MED`：越小越优；缺失按默认值 `DefaultMED = 0` 处理。
6. 稳定邻居地址：全属性并列时按邻居传输地址的字节序决胜，IPv4 排在 IPv6 前，未指定地址（本地路由）最前。
7. 稳定键：保证独立调用时比较器是全序；RIB 中每个（前缀，邻居）至多一条路由，正常选择不会走到该步。

## 路由反射

- `CheckReflectionLoop`：按 RFC 4456 检查 `ORIGINATOR_ID` 与 `CLUSTER_LIST` 环路（`ErrOriginatorLoop` / `ErrClusterLoop`）。
- `ReflectRoute`：仅在缺失时写入 `ORIGINATOR_ID`，将本集群 ID 前插 `CLUSTER_LIST`；EBGP 路由补默认 `LOCAL_PREF`；不修改输入。
- `Reflectable`：实现客户端/非客户端/EBGP 的 RR 传播矩阵。

## RIB 与收敛

- `RIB.Update` 按（前缀，邻居地址）插入或替换，内部深拷贝，不与调用方共享切片。
- `RIB.Withdraw` 幂等；最后一条路由撤回后前缀自动移除。
- `RIB.BestWithReason` 返回选中路由与第一条生效的决胜规则。
- `RIB.Apply` 重放交错的更新/撤回事件流；`Snapshot` / `RestoreSnapshot` 支持状态回放。
- 选择结果只取决于当前存活路由集合，与事件顺序无关；重算幂等，更新/撤回交错后单调收敛到同一定点。

## 验证

- 小路由集穷举：独立重写一份逐条规则的参考实现，对全部属性组合做两两符号比对，并枚举 10 条路由的全部子集与 300 组随机子集/随机顺序。
- 收敛测试：400 步随机更新/撤回交错，每步核对决定性、幂等重算、选中路由必属存活集且严格不劣于任何候选；末尾用 8 种重放顺序与“抽干再加回”验证顺序无关与定点收敛。
- 反射测试覆盖环路拒绝、属性重写与传播矩阵。

运行：

```sh
go vet ./...
go test -race -count=1 ./...
```
