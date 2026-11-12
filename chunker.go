package dataeng

import (
	"crypto/sha256"
	"errors"
	"math/bits"
)

// ErrPaused 表示分块器在回调暂停后等待恢复。
// 触发暂停的那次 Write 已经通过返回的已消费字节数标明进度，
// 恢复前再次调用 Write 或 Finish 会原样返回 ErrPaused，恢复后不重发已切块。
var ErrPaused = errors.New("dataeng: chunker paused, call Resume before continuing")

// Options 是内容定义分块的参数。
type Options struct {
	// Min 是块的最小长度，1 <= Min <= Max。
	Min int
	// Max 是块的最大长度，达到该长度强制切块。
	Max int
	// Window 是滚动摘要保留的最近字节窗口宽度，必须为正数。
	Window int
	// Mod 是滚动摘要的模数，必须大于 1。
	Mod uint64
	// Rem 是触发切块的摘要余数，0 <= Rem < Mod。
	Rem uint64
}

// Chunk 是一次切块的结果。Data 是该块的原始字节副本，
// Start 是该块在整个输入流中的字节起点，Sum 是 Data 的 SHA256。
type Chunk struct {
	Start int64
	Data  []byte
	Sum   [sha256.Size]byte
}

// EmitFunc 接收每个已完成的块。返回 true 表示暂停消费，
// 此时该块视为已被接收，分块器停止处理后续输入并等待 Resume。
type EmitFunc func(Chunk) (pause bool)

// Chunker 对字节流做内容定义分块。单个 Chunker 不是并发安全的。
// 内存中只保留最近 Window 个字节的滚动窗口和当前正在积累的块。
type Chunker struct {
	opts Options
	emit EmitFunc

	window []byte // 长度固定为 Window 的环形缓冲
	wPos   int    // 下一个写入位置
	wFill  int    // 已填充字节数，饱和到 Window
	hash   uint64 // 当前滚动摘要 h
	powW   uint64 // 257^Window mod Mod

	block []byte // 当前块
	pos   int64  // 当前块在全文件中的起点

	paused bool
}

// NewChunker 按参数创建分块器，参数非法时返回错误。
func NewChunker(opts Options, emit EmitFunc) (*Chunker, error) {
	if opts.Min < 1 || opts.Max < opts.Min {
		return nil, errors.New("dataeng: require 1 <= Min <= Max")
	}
	if opts.Window < 1 {
		return nil, errors.New("dataeng: Window must be positive")
	}
	if opts.Mod <= 1 {
		return nil, errors.New("dataeng: Mod must be greater than 1")
	}
	if opts.Rem >= opts.Mod {
		return nil, errors.New("dataeng: require 0 <= Rem < Mod")
	}
	if emit == nil {
		return nil, errors.New("dataeng: emit callback must not be nil")
	}
	return &Chunker{
		opts:   opts,
		emit:   emit,
		window: make([]byte, opts.Window),
		powW:   powMod(257, opts.Window, opts.Mod),
	}, nil
}

// Write 将 p 中的字节送入分块器，返回已消费的字节数。
// 若回调要求暂停，返回 ErrPaused，且 n 是暂停前已消费的字节数；
// p[n:] 属于已交付块之后的剩余输入，由调用方在 Resume 后重新送入，分块器不会重发。
func (c *Chunker) Write(p []byte) (n int, err error) {
	if c.paused {
		return 0, ErrPaused
	}
	return c.ingest(p)
}

// Finish 显式结束输入流。若当前块非空则交付为残块；
// 空文件（从未收到字节）不产生任何块。暂停状态下返回 ErrPaused。
func (c *Chunker) Finish() error {
	if c.paused {
		return ErrPaused
	}
	if len(c.block) > 0 {
		return c.dispatch()
	}
	return nil
}

// Resume 在回调暂停后恢复消费。它只清除暂停状态，
// 不重发已交付的块，也不保存触发暂停那次 Write 的未消费输入。
func (c *Chunker) Resume() {
	c.paused = false
}

func (c *Chunker) ingest(p []byte) (int, error) {
	for i, b := range p {
		c.updateWindow(b)
		c.block = append(c.block, b)

		length := len(c.block)
		if length >= c.opts.Max || (length >= c.opts.Min && c.hash == c.opts.Rem) {
			if err := c.dispatch(); err != nil {
				// 第 i 个字节已处理且其所在块已交付，已消费数量为 i+1；
				// p[i+1:] 才是需要调用方在 Resume 后重新送入的剩余输入。
				return i + 1, err
			}
		}
	}
	return len(p), nil
}

func (c *Chunker) dispatch() error {
	sum := sha256.Sum256(c.block)
	chunk := Chunk{
		Start: c.pos,
		Data:  append([]byte(nil), c.block...),
		Sum:   sum,
	}
	// 块已交付，丢弃内部缓冲，仅保留窗口。
	c.block = nil
	c.pos += int64(len(chunk.Data))

	if c.emit(chunk) {
		c.paused = true
		return ErrPaused
	}
	return nil
}

// updateWindow 把 b 纳入“最近至多 Window 个字节”的滚动摘要。
// 窗口未满时 h = h*257 + b；窗口已满时先移出最旧字节，
// 全程对 Mod 取模，任何中间值都不依赖 uint64 溢出回绕。
func (c *Chunker) updateWindow(b byte) {
	m := c.opts.Mod
	if c.wFill < c.opts.Window {
		c.wFill++
		c.hash = addMod(mulMod(c.hash, 257, m), uint64(b), m)
	} else {
		// 写满后，下一个写入位置 wPos 恰好持有最旧字节，先取出再覆盖。
		old := c.window[c.wPos]
		// h' = h*257 - old*257^Window + b (mod m)
		next := mulMod(c.hash, 257, m)
		next = subMod(next, mulMod(uint64(old), c.powW, m), m)
		next = addMod(next, uint64(b), m)
		c.hash = next
	}
	c.window[c.wPos] = b
	c.wPos = (c.wPos + 1) % c.opts.Window
}

// mulMod 返回 (a*b) mod m，使用 128 位中间乘积，适配任意 uint64 模数。
func mulMod(a, b, m uint64) uint64 {
	hi, lo := bits.Mul64(a, b)
	_, rem := bits.Div64(hi, lo, m)
	return rem
}

// powMod 返回 base^exp mod m，exp 非负，中间过程不依赖溢出回绕。
func powMod(base uint64, exp int, m uint64) uint64 {
	pow := uint64(1)
	for i := 0; i < exp; i++ {
		pow = mulMod(pow, base, m)
	}
	return pow
}

// addMod 返回 (a+b) mod m，对任意 uint64 输入精确。
// 和的 128 位表示为 (carry, lo)；由于 m > 1，carry（0 或 1）恒小于 m，
// bits.Div64 的前置条件始终满足，直接对完整 128 位和取模，
// 不依赖“uint64 先溢出再取模”的回绕巧合。
func addMod(a, b, m uint64) uint64 {
	lo, carry := bits.Add64(a, b, 0)
	_, rem := bits.Div64(carry, lo, m)
	return rem
}

// subMod 返回 (a-b) mod m。由于 a、b 均小于 m，差落在 (-m, m) 内，
// 借位时加回 m 即得到非负余数，无需依赖溢出回绕。
func subMod(a, b, m uint64) uint64 {
	lo, borrow := bits.Sub64(a, b, 0)
	if borrow == 1 {
		lo, _ = bits.Add64(lo, m, 0)
	}
	if lo >= m {
		lo, _ = bits.Sub64(lo, m, 0)
	}
	return lo
}
