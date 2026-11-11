package q251

import (
	"encoding/binary"
	"errors"
	"hash/fnv"
	"slices"
	"sync"
	"time"
)

// MaxWindow 是活动窗口的上界。窗口必须小于 16 位序号空间的半圈，
// 这样才能用 RFC 1982 风格的有符号差无歧义地判断序号先后。
const MaxWindow = 1<<15 - 1

var (
	ErrInvalidConfig = errors.New("q251: invalid configuration")
	ErrFrameSize     = errors.New("q251: packet sample count does not match frame size")
	// ErrConflict 表示收到与已缓存或已交付内容不同的重复包。
	ErrConflict = errors.New("q251: duplicate packet with different payload")
	// ErrTimestampSkew 表示包时戳与序号推算出的期望时戳不一致。
	ErrTimestampSkew = errors.New("q251: packet timestamp inconsistent with sequence number")
)

// Packet 是一帧入包：16 位序号、32 位采样时戳和固定数量的 PCM 样点。
type Packet struct {
	Seq       uint16
	Timestamp uint32
	Samples   []int16
}

// Frame 是按采样时钟交付给调用方的一帧。
type Frame struct {
	Seq       uint16
	Timestamp uint32
	Samples   []int16
	// Lost 为 true 时 Samples 是静音（全零），表示截止时包未到。
	Lost bool
}

// Stats 是抖动缓冲的累计统计。
type Stats struct {
	Received     uint64 // 接受入缓冲的新包
	Delivered    uint64 // 带数据交付的帧
	Lost         uint64 // 截止仍缺包、以静音交付的帧
	Late         uint64 // 迟到且无法核对的包（对应帧已交付且超出历史）
	Duplicates   uint64 // 内容一致的重复包
	Conflicts    uint64 // 内容不同的重复包 / 时戳不一致
	DroppedAhead uint64 // 超出活动窗口被丢弃的包
	Resets       uint64 // 流代际切换次数
}

// Config 配置一个 JitterBuffer。
type Config struct {
	SampleRate int   // 每秒样点数
	FrameSize  int   // 每包固定 PCM 样点数
	Window     int   // 活动窗口（最多缓存的包数），必须 <= MaxWindow
	Clock      Clock // nil 时使用 RealClock
}

// JitterBuffer 是实时语音宿主的抖动缓冲。调用方按采样时钟循环调用
// NextFrame 取下一帧；网络侧随时调用 Push 入包。两者可并发。
type JitterBuffer struct {
	clock     Clock
	frameSize int
	frameDur  time.Duration
	window    int

	mu        sync.Mutex
	started   bool          // 首包已建立基准
	baseSeq   uint16        // 下一个待交付帧的序号
	baseTS    uint32        // 下一个待交付帧的时戳
	baseTime  time.Duration // 基准建立时的时钟读数
	delivered uint64        // 本代际已交付帧数
	gen       uint64        // 流代际
	changed   chan struct{} // 状态变化广播（首包到达 / Reset）

	slots   map[uint16][]int16 // 窗口内缓存的包
	hist    map[uint16]uint64  // 最近交付帧的内容哈希，用于冲突检测
	histQ   []uint16           // hist 的 FIFO 淘汰队列
	histMax int

	stats Stats
}

// New 创建抖动缓冲。Window 必须小于序号半圈（<= MaxWindow）。
func New(cfg Config) (*JitterBuffer, error) {
	if cfg.SampleRate <= 0 || cfg.FrameSize <= 0 || cfg.Window <= 0 {
		return nil, ErrInvalidConfig
	}
	if cfg.Window > MaxWindow {
		return nil, ErrInvalidConfig
	}
	frameDur := time.Duration(cfg.FrameSize) * time.Second / time.Duration(cfg.SampleRate)
	if frameDur <= 0 {
		return nil, ErrInvalidConfig
	}
	clock := cfg.Clock
	if clock == nil {
		clock = NewRealClock()
	}
	return &JitterBuffer{
		clock:     clock,
		frameSize: cfg.FrameSize,
		frameDur:  frameDur,
		window:    cfg.Window,
		changed:   make(chan struct{}),
		slots:     make(map[uint16][]int16),
		hist:      make(map[uint16]uint64),
		histMax:   cfg.Window,
	}, nil
}

// Push 入包。首包建立时戳与序号基准；窗口外的包被丢弃；
// 内容不同的重复包返回 ErrConflict。Push 永不修改已交付的帧。
func (jb *JitterBuffer) Push(p Packet) error {
	if len(p.Samples) != jb.frameSize {
		return ErrFrameSize
	}
	samples := make([]int16, len(p.Samples))
	copy(samples, p.Samples)

	jb.mu.Lock()
	defer jb.mu.Unlock()

	if !jb.started {
		jb.started = true
		jb.baseSeq = p.Seq
		jb.baseTS = p.Timestamp
		jb.baseTime = jb.clock.Now()
		jb.delivered = 0
		jb.slots[p.Seq] = samples
		jb.stats.Received++
		jb.signalLocked()
		return nil
	}

	off := int16(p.Seq - jb.baseSeq)
	if off < 0 {
		// 迟到包：对应帧已交付，绝不回改，只核对内容。
		h, ok := jb.hist[p.Seq]
		switch {
		case !ok:
			jb.stats.Late++
		case h == hashSamples(samples):
			jb.stats.Duplicates++
		default:
			jb.stats.Conflicts++
			return ErrConflict
		}
		return nil
	}
	if int(off) >= jb.window {
		jb.stats.DroppedAhead++
		return nil
	}
	want := jb.baseTS + uint32(off)*uint32(jb.frameSize)
	if p.Timestamp != want {
		jb.stats.Conflicts++
		return ErrTimestampSkew
	}
	if old, ok := jb.slots[p.Seq]; ok {
		if slices.Equal(old, samples) {
			jb.stats.Duplicates++
			return nil
		}
		jb.stats.Conflicts++
		return ErrConflict
	}
	jb.slots[p.Seq] = samples
	jb.stats.Received++
	return nil
}

// NextFrame 阻塞到下一帧的截止时间，然后交付该帧：包已到则交付数据，
// 否则交付静音并记一次缺失。无论是否缺包，返回帧的序号与时戳都严格
// 连续（时戳每帧递增 FrameSize，自然回绕）。
func (jb *JitterBuffer) NextFrame() Frame {
	jb.mu.Lock()
	for {
		if jb.started {
			deadline := jb.baseTime + time.Duration(jb.delivered)*jb.frameDur
			if d := deadline - jb.clock.Now(); d > 0 {
				t := jb.clock.NewTimer(d)
				ch := jb.changed
				jb.mu.Unlock()
				select {
				case <-t.C():
				case <-ch:
				}
				t.Stop()
				jb.mu.Lock()
				continue
			}
			break
		}
		ch := jb.changed
		jb.mu.Unlock()
		<-ch
		jb.mu.Lock()
	}

	f := Frame{Seq: jb.baseSeq, Timestamp: jb.baseTS}
	if s, ok := jb.slots[jb.baseSeq]; ok {
		f.Samples = s
		delete(jb.slots, jb.baseSeq)
		jb.rememberLocked(jb.baseSeq, hashSamples(s))
		jb.stats.Delivered++
	} else {
		f.Samples = make([]int16, jb.frameSize)
		f.Lost = true
		jb.stats.Lost++
	}
	jb.baseSeq++
	jb.baseTS += uint32(jb.frameSize)
	jb.delivered++
	jb.mu.Unlock()
	return f
}

// Reset 显式切换到新的流代际：清空全部缓存包与交付历史，
// 下一个到达的包重新建立基准。正在阻塞的 NextFrame 会被唤醒重试。
func (jb *JitterBuffer) Reset() {
	jb.mu.Lock()
	defer jb.mu.Unlock()
	jb.gen++
	jb.started = false
	jb.delivered = 0
	jb.slots = make(map[uint16][]int16)
	jb.hist = make(map[uint16]uint64)
	jb.histQ = jb.histQ[:0]
	jb.stats.Resets++
	jb.signalLocked()
}

// Stats 返回统计快照。
func (jb *JitterBuffer) Stats() Stats {
	jb.mu.Lock()
	defer jb.mu.Unlock()
	return jb.stats
}

// Buffered 返回当前缓存的包数，恒不超过 Window。
func (jb *JitterBuffer) Buffered() int {
	jb.mu.Lock()
	defer jb.mu.Unlock()
	return len(jb.slots)
}

// Generation 返回当前流代际（Reset 次数）。
func (jb *JitterBuffer) Generation() uint64 {
	jb.mu.Lock()
	defer jb.mu.Unlock()
	return jb.gen
}

func (jb *JitterBuffer) signalLocked() {
	close(jb.changed)
	jb.changed = make(chan struct{})
}

func (jb *JitterBuffer) rememberLocked(seq uint16, h uint64) {
	jb.hist[seq] = h
	jb.histQ = append(jb.histQ, seq)
	if len(jb.histQ) > jb.histMax {
		delete(jb.hist, jb.histQ[0])
		jb.histQ = jb.histQ[1:]
	}
}

func hashSamples(s []int16) uint64 {
	h := fnv.New64a()
	var b [2]byte
	for _, v := range s {
		binary.LittleEndian.PutUint16(b[:], uint16(v))
		h.Write(b[:])
	}
	return h.Sum64()
}
