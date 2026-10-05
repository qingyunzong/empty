# frameindex

帧索引库：显式记录每帧的参考帧 ID、解码时间（DecodeTime）与显示时间（DisplayTime），
按目标显示区间求最小依赖闭包，输出拓扑证书，并用全图 DFS 参考模型交叉核对。
仅使用 Go 标准库。

## 设计

- `Frame`：`ID` / `DecodeTime` / `DisplayTime` / `Refs`（显式参考帧 ID 列表）。
- `Index.Add`：录入帧，拒绝空 ID 与重复 ID。
- `Index.SeekInterval(start, end)`：以显示时间落在闭区间内的帧为目标，沿显式参考边
  做三色 DFS 传递闭包，得到最小依赖闭包；缺失参考记入 `Plan.Missing`，
  依赖环记入 `Plan.Cycles`。显示时间只用于选目标帧，绝不参与解码排序。
- `Index.Certify(plan)`：拓扑证书。证书顺序严格按 DecodeTime 升序（ID 兜底），
  即解码序由解码时间决定，不能按显示时间当解码序。若闭包内存在与解码序矛盾的
  依赖边（环是其特例），拒绝签发并报告。
- `Index.Verify(cert, plan)`：独立核验证书——模拟解码器按证书顺序解码，
  每帧的参考必须先于它出现。
- `Index.CheckAgainstModel(plan)`：全图 DFS 参考模型核对，独立实现、不复用
  SeekInterval 内部逻辑：比对闭包集合、缺失参考列表、环判定三者一致。

## 测试

覆盖：GOP 乱序（I/P/B）最小闭包、证书使用解码序而非显示序、缺失参考报告、
环报告与拒绝签发、区间端点规整与空区间、录入校验、显示序非非解码序，
以及 500 组随机图（随机缺失参考/环/双时间轴打散）对全图 DFS 模型的性质核对。

实际运行结果（go test ./...，Go go1.27.1，2026-10-05）：

```
ok  	frameindex	0.013s
```
