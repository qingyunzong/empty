# 浏览器下载事件与文件落盘竞态

`dataeng` 是一个可导入的 Go 下载协调库，用于把浏览器下载事件与最终落盘文件关联起来。

## 能力

- 以浏览器 download id 跟踪建议文件名、临时路径、完成事件和最终 SHA-256。
- 完成事件早于文件写完时，轮询临时文件长度，只有长度在稳定窗口内不再变化才继续。
- 支持可选的期望文件长度与 SHA-256 校验。
- 校验通过且原子改名成功后才发布 `Artifact`；失败不会产生可见的采集对象。
- 取消、覆盖已有文件和同名并发下载互不干扰：
  - 取消会唤醒所有等待者，但不发布、不删除浏览器临时文件。
  - `Overwrite` 只在校验成功后原子替换目标文件。
  - 未开启 `Overwrite` 时，同名下载自动分配 `name (1).ext` 一类的新名称。
- 支持同一下载的多个 `Wait` 调用者，它们会得到同一个 `Artifact`。

## 使用

```go
coord, err := dataeng.New(
    "/data/collected",
    dataeng.WithPollInterval(10*time.Millisecond),
    dataeng.WithStableWindow(150*time.Millisecond),
)
if err != nil {
    return err
}

download, err := coord.Track(dataeng.DownloadSpec{
    ID:             "browser-download-id",
    SuggestedName:  "report.pdf",
    TempPath:       "/browser/tmp/report.pdf.crdownload",
    ExpectedSHA256: expectedDigest, // 可省略；省略时仍会计算实际摘要
})
if err != nil {
    return err
}

// 浏览器完成事件可以先于临时文件写完到达。
if err := coord.OnComplete(dataeng.CompletionEvent{ID: "browser-download-id"}); err != nil {
    return err
}

artifact, err := download.Wait(ctx)
if err != nil {
    return err
}
fmt.Println(artifact.Path, artifact.Size, artifact.SHA256)
```

不区分事件阶段时，也可以直接调用 `coord.Complete(ctx, id)`，它等价于记录完成事件后执行 `Wait`。

## 状态与失败

下载只有在以下步骤全部成功后进入 `published` 状态：

1. 临时文件存在且为普通文件，长度稳定；
2. 长度符合 `ExpectedSize`（若设置）；
3. 实际 SHA-256 符合 `ExpectedSHA256`（若设置）；
4. 目标文件名已隔离分配，且原子移动成功。

摘要错误、长度错误或目标冲突会返回可用 `errors.Is` 判断的错误，并且不会移动临时文件。取消后临时文件仍由浏览器/调用方管理。上下文超时不会破坏下载状态，之后可以再次调用 `Wait` 重试。
