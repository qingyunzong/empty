# 向量瓦片属性字典归并

地图数据入口需要可直接接入 Go MVT layer 归并库，重建 keys/values/tag 索引并合并多个 tile fragment。属性值类型不同不能仅按文本合并，geometry command 只在 extent 一致时拼接；输出字典按稳定排序重编号且所有 tag 引用有效。

## 安装与依赖

纯 Go 实现，仅依赖标准库（手写 MVT protobuf wire 编解码），`go build ./...`
即可，无需外部 module 或网络。

## 快速开始

数据入口直接喂入 MVT 字节流：

```go
merged, err := dataeng.MergeBytes(fragmentA, fragmentB, fragmentC)
if err != nil {
    return err
}
// merged 即合并、重编码后的 MVT tile 字节流
```

需要增量累积时使用 Merger：

```go
merger := dataeng.NewMerger()
for _, fragment := range fragments {
    tile, err := dataeng.Unmarshal(fragment)
    if err != nil {
        return err
    }
    if err := merger.AddTile(tile); err != nil {
        return err
    }
}
out := merger.Build()
raw, err := dataeng.Marshal(out)
```

## 归并规则

- **同名 layer 归并**：输出 layer 按名称首次出现的顺序排列，字典（keys/values）全局重建。
- **类型安全的值字典**：`Value` 用指针字段区分 proto2 显式零值与未设置；
  string/float/double/int/uint/sint/bool 七类各自独立，文本 `"1"`、整数 `1`、
  布尔 `true`、浮点 `1.0` 不会被按文本折叠，`int(0)`、`bool(false)`、`""` 等零值正常入字典。
- **稳定排序与重编号**：keys 按字节序；values 先按 MVT proto 字段号（类型秩），
  同类型再按载荷全序比较（含 IEEE-754 NaN 的确定序）。排序后所有 tag 引用按
  新字典重写，`Marshal` 对 key/value 索引边界做最终校验，杜绝悬空引用。
- **extent 守卫的几何拼接**：仅当两个 feature 所在 layer 的有效 extent 相同、
  ID 相同且 GeomType 相同时才归并，geometry command 流原样拼接（MVT 相对位移
  不做坐标变换）；extent 不同的要素保持独立，绝不跨尺度拼接。extent/version
  缺省按规范补 4096/1。
- **输入校验**：奇数 tag、越界 tag 索引、非法 Value、截断的几何 command 流、
  空 layer 名等情况返回带上下文的错误，而不是产出坏瓦片。

## 代码结构

| 文件 | 职责 |
| --- | --- |
| `model.go` | Tile/Layer/Feature/Value/GeomType 内存模型 |
| `wire.go` `encode.go` `decode.go` | protobuf wire 编解码与输出校验 |
| `value.go` | 类型秩、类型安全去重键与稳定全序排序 |
| `geometry.go` | zigzag、command integer 与 extent 守卫拼接 |
| `merge.go` | Merger、Merge、MergeBytes 归并主流程 |

运行测试：`go test ./...`（含 `-race` 与编解码往返、边界用例）。
