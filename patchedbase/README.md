# patchedbase

单 run patched-base 整数体解码器，只实现封闭定义的体格式，不含容器、RLE
其他模式或编码优化。

## 体布局（高位先行，按字节补零）

1. `BW` 字节大端基值：最高位是符号位，清符号位后的无符号数是绝对值；
   符号置位取相反数（非二补码扩展），负零按 0 接受。
2. `N` 个 `W` 位无符号低部，连续打包并补到下一字节。
3. `P` 个补丁槽：槽宽 `F` 是宽度集合 `{1..24,26,28,30,32,40,48,56,64}`
   中最小的不小于 `G+PW` 者；每槽低 `PW` 位是 patch、其上 `G` 位是 gap，
   更高位必须为 0；段尾补到下一字节且填充位必须为 0。

## 补丁定位

- `cursor` 从 0 起，每槽先 `cursor += gap`。
- `G=8 && gap=255 && patch=0` 是长间隙延续：不改任何低部，cursor 继续累计，
  可连用；最后一个槽不允许是延续。
- 其余槽 `patch` 必须非 0，`cursor < N` 且严格大于上一个真补丁位置，
  然后执行 `low[cursor] |= patch << W`，cursor 不额外加 1。
- 低部全部读完后才应用补丁；延续槽不对应数值，只记在后继真补丁的
  `GapSources` 中。

## 范围与状态

- 修复后的无符号差值与有符号基值用 `math/big` 相加，结果必须落在 int64，
  否则整 run 报 `KindOverflow`，不回绕、不做 zigzag。
- `Push` 接受任意切块；`Finish` 才校验体长、尾填充、补丁定位与溢出。
- 失败类别：`KindInvalidParameter`、`KindTruncated`、`KindExtraBytes`、
  `KindPadding`、`KindBadContinuation`、`KindPatchPosition`、
  `KindOverflow`、`KindState`，可用 `errors.Is`/`errors.As` 辨识。
- 失败后实例不可继续 `Push`，宿主新建实例处理下一 run。
- 缓存只按校验后的参数分配（最多 512 个低部、31 个槽），不信任声明体长。

## 测试

`patchedbase_test.go` 自带独立 MSB-first 编码器和逐位 `big.Int` 参考实现，
对每个用例在全部字节切块点上跑一遍并与参考交叉核对；`example_host_test.go`
是列接入宿主调用例。
