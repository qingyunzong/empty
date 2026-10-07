# fanout

`fanout` 把字节流扇出到一个主目的地和若干可选镜像。

## 语义

- **主目的地同步写**：`Write` 同步写主目的地，主背压直接传播给调用方，镜像绝不吸收或拖延它。
- **镜像异步、缓冲有界**：每个镜像由独立泵 goroutine 经有界缓冲（≤ N 字节，`WithBufferSize`）喂数据。缓冲将溢出时该镜像被截断，保留已收到的前缀，溢出记为 `MirrorError`。
- **镜像失败不阻主**：镜像写失败或饱和只通过 `MirrorErrors()` 枚举上报，主路径不受影响。
- **主失败取消全部**：主写失败即终止——取消所有泵、丢弃镜像待写数据，后续 `Write` 返回该错误；`Context()` 随之取消，供阻塞中的目的地感知。
- **前缀性质**：镜像收到的字节永远是流的有序、无空洞前缀，只在尾部截断。
- **关闭一次**：`Close` 幂等，冲刷镜像缓冲、等待泵退出并返回主错误；重复调用返回相同结果。

## 用法

```go
w := fanout.New(primary,
    fanout.WithBufferSize(64*1024),        // 每目的地缓冲上限 N
    fanout.WithContext(ctx),               // 可选：外部取消
    fanout.WithMirror("audit", mirror1),
    fanout.WithMirror("backup", mirror2),
)
n, err := w.Write(chunk)                   // 主背压直接体现在此
...
err = w.Close()                            // 幂等；返回主错误（若有）
perr := w.Err()                            // 主/取消的终止错误
for _, me := range w.MirrorErrors() {      // 枚举镜像失败与丢弃字节数
    log.Printf("mirror %s: %v (dropped %d)", me.Name, me.Err, me.Dropped)
}
```

## 测试

```sh
go test ./...
```

覆盖：正常路径、主失败取消全部、镜像失败不阻主、慢镜像背压与缓冲上界、
关闭幂等、上下文取消、并发下前缀性质（`-race` 通过）。
