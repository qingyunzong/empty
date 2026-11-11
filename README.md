音频导入宿主需要Go Ogg包重组组件，校验页头、CRC及每个serial的连续页号，按lacing表拼包：255表示本包继续，小于255结束一个包，0允许空包；页内可有多包，包也可跨页。continued标志必须与该serial的未完包一致，丢页时丢弃该未完包并报告缺口；各serial独立，结束页不能留下半包。通过调用方回调交付包、页来源及该页最后完整包的granule position，其他包不伪造时间。用交错serial、恰255字节包和页内空包夹具验证任意字节切块与CRC失败不交付。

## Ogg 重组组件 (`package q215`)

`Demuxer` 实现 `io.WriteCloser` 风格的流式 Ogg 解封装，输入可按任意字节切块
`Write`，内部缓冲并按页处理。

### 校验与重组语义

- 校验捕获字 `OggS`、版本号、保留标志位与页 CRC-32（多项式 `0x04c11db7`）；
  CRC 失败的页不交付任何包，并自动重同步到下一个捕获字。
- 每个 stream serial 独立维护连续页号；检测到缺口时丢弃该 serial 未完成的包，
  通过 `OnGap` 报告 `Expected/Got` 页号。
- lacing 表重组：`255` 表示当前包继续，`<255`（含 `0` 空包）闭合一个包；
  单页可含多包，单包可跨多页。
- `continued` 标志必须与该 serial 的未完包状态一致，否则经 `OnError` 报告
  `ErrContinuation`：孤儿续页内容被丢弃到首个终止符，丢失续页时旧半包被废弃。
- EOS 页若留下半包报 `ErrEOS`；`Close` 时仍有未闭合包返回 `ErrTruncated`。

### 回调交付

`Config.OnPacket` 交付完整 `Packet`：

- `Data` 为独立拷贝，回调返回后仍有效；
- `Source` 给出包闭合所在页的 serial、页序号与字节偏移；
- 仅该页最后一个完整包在页 granule 非 `-1` 时带 `HasGranule/Granule`，
  其余包不伪造时间。

### 测试夹具

- `TestReassemblyAllChunkings`：双 serial 交错、跨页包、恰 255 字节包、
  页内多个空包，按 1 字节到整流等 30 种切块方式验证结果一致；
- `TestCRCFailureDeliversNothing` / `TestCRCFailureResyncsAcrossGarbage`：
  CRC 失败页零交付且能跨垃圾字节重同步；
- 另含缺口丢包、continued 失配、EOS 半包、截断、granule 归属与偏移量测试。

运行：`go test ./...`
