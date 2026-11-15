// Package dataeng 提供零依赖的 Mapbox Vector Tile (MVT) layer 归并能力，
// 可直接接入地图数据入口，合并多个 tile fragment 并重建属性字典。
//
// 核心入口：
//
//   - MergeBytes：输入若干 MVT 编码字节流，输出合并并重编码后的字节流。
//   - Merger：增量式归并器，AddTile/AddLayer 累积 fragment，Build 产出 Tile。
//   - Merge：对已解码 Tile 的一次性归并便捷函数。
//   - Marshal/Unmarshal：手写的 MVT protobuf wire 编解码，兼容 packed 与
//     非 packed 的 tags/geometry 编码，仅依赖 Go 标准库。
//
// 归并语义：
//
//   - 同名 layer 合并为一个输出 layer，keys/values 字典全局重建。
//   - Value 按 MVT proto 字段区分类型（string/float/double/int/uint/sint/
//     bool），不同类型即使文本表示相同也不会合并；显式零值（如 int(0)、
//     bool(false)、空字符串）通过指针字段保留。
//   - 同 extent、同 ID、同几何类型的 feature 归并为一个 feature，tag 对取
//     并集去重，geometry command 流直接拼接；extent 不一致时拒绝拼接，
//     feature 保留为独立要素，避免跨网格尺度混用坐标。
//   - 输出字典按稳定全序排序并重新编号：keys 按字节序，values 先按类型秩
//     （proto 字段号）再按同类型载荷排序；所有 feature 的 tag 引用在 Build
//     时基于新字典重写，Marshal 再做一次边界校验，保证引用全部有效。
package dataeng
