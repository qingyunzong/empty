# maintsched — 检修库停机排程

为 ≤10 台设备选择整数停机区间：设备 i 需在半开窗口
`[windowStart, windowEnd)` 内安排固定时长 `duration` 的连续停机区间
`[t, t+duration)`（即 `windowStart <= t` 且 `t+duration <= windowEnd`）。
任意时刻同时停机的设备数不超过 `K`；时刻 `t` 每台停机设备产生
`loss[t]` 的损失，目标为最小化总损失。

## 用法

```sh
echo '{"devices":[{"duration":3,"windowStart":2,"windowEnd":6}],"k":1,"loss":[0,0,10,10,10,0,0,0]}' | go run .
# 或 go run . -f instance.json
```

输出 JSON：`minLoss`（最小总损失）、`starts`（各设备起始时刻）、
`occupancy`（逐时刻停机台数曲线）。无可行解时退出码为 1。

## 实现

- `sched.go`：带备忘录的 DP，状态为（时刻, 已开工位掩码, 在修设备剩余
  时长多重集），逐时刻枚举新开工设备子集（受 K 与窗口左端约束）。
- `brute.go`：穷举所有起始时刻组合，用于短时域正确性核验。
- `sched_test.go`：半开边界（窗口右端/区间右端均排他）、并发上限、
  占用加权损失、不可行判定，以及 300 组随机实例 DP 对拍穷举。

## 测试

```sh
go test ./...
```
