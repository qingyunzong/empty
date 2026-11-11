实时语音宿主需要Go抖动缓冲组件，包带16位序号、32位采样时戳和固定数量PCM样点，首包建立基准，活动窗口小于序号半圈。调用方按采样时钟取下一帧，到截止仍缺包返回静音并记缺失，迟到包不得修改已交付帧；重复内容不同报冲突。支持显式切换流代际并清空旧包。以可控时钟测试双回绕、乱序、取帧与入包竞争及流重置，保证输出时戳连续和缓冲上限。

## 用法

```go
jb, _ := q251.New(q251.Config{
    SampleRate: 8000,   // 每秒样点数
    FrameSize:  160,    // 每包固定 PCM 样点数（20ms）
    Window:     64,     // 活动窗口，必须 <= q251.MaxWindow（小于序号半圈）
    Clock:      nil,    // nil 用真实时钟；测试传 q251.NewFakeClock()
})

// 网络侧
err := jb.Push(q251.Packet{Seq: seq, Timestamp: ts, Samples: samples})
// err 可能是 q251.ErrConflict（重复包内容不同）或 q251.ErrTimestampSkew

// 播放侧：按采样时钟循环取帧，阻塞到截止；缺包返回静音帧（Frame.Lost=true）
frame := jb.NextFrame()

// 流代际切换：清空旧包，下一个包重建基准
jb.Reset()
```

测试：`go test -race ./...`
