package dataeng

import "math/bits"

// 块的固定费用：2 字节头 + 8 字节首值。
const (
	headerBytes   = 2
	firstBytes    = 8
	blockOverhead = headerBytes + firstBytes
)

// MaxSamplesPerBlock 是单块允许的最大样本数。
const MaxSamplesPerBlock = 64

// MaxBitWidth 是差值二补码位宽的上限：两个 int64 端点之差最坏需要 65 位。
const MaxBitWidth = 65

// deltaBitWidth 返回以 b 位二补码表示单个数学整数差值 d 所需的最小 b（0..65）。
// d 为 int64 端点之差，调用方按数学整数（带符号）计算后再传入。
func deltaBitWidth(d int64) int {
	if d == 0 {
		return 0
	}
	// 将差值映射为其数学绝对值的无符号表示，避免直接取负时的溢出。
	u := uint64(d)
	neg := d < 0
	if neg {
		u = 0 - u // |d|；MinInt64 时仍正确
	}
	// 正数 u：需 2^(b-1) > u，即 b = bitlen(u)+1。
	// 负数 -u：需 2^(b-1) >= u，即 b = bitlen(u-1)+1（u=1 时 bitlen(0)=0，得 b=1）。
	if neg {
		return bits.Len64(u-1) + 1
	}
	return bits.Len64(u) + 1
}

// intDelta 返回两个 int64 端点的数学差值 next-prev。
// 当数学差值落在 int64 范围外（溢出差）时 ok 为 false，调用方须改以 65 位处理。
func intDelta(prev, next int64) (d int64, ok bool) {
	d = next - prev
	switch {
	case prev < 0 && next >= 0:
		// 数学结果非负；未上溢时回绕值 d 也必为非负。
		return d, d >= 0
	case prev >= 0 && next < 0:
		// 数学结果为负；未下溢时回绕值 d 也必为负。
		return d, d < 0
	default:
		return d, true
	}
}

// blockBitWidth 返回一段样本（至少 1 条）的统一位宽，即所有相邻差所需位宽的最大值。
func blockBitWidth(samples []int64) int {
	width := 0
	for i := 1; i < len(samples); i++ {
		d, ok := intDelta(samples[i-1], samples[i])
		w := MaxBitWidth
		if ok {
			w = deltaBitWidth(d)
		}
		if w > width {
			width = w
		}
	}
	return width
}

// blockPayloadBytes 返回差值负载字节数：每条差值 b 位，向上取整到整字节。
func blockPayloadBytes(width, sampleCount int) int {
	return (width*(sampleCount-1) + 7) / 8
}

// blockCost 返回单块总字节数：固定开销 10 字节加差值负载。
func blockCost(width, sampleCount int) int {
	return blockOverhead + blockPayloadBytes(width, sampleCount)
}

// lowMask 返回低 width 位全 1 的掩码；width 为 0 时返回 0，width>=64 时返回全 1。
func lowMask(width int) uint64 {
	if width <= 0 {
		return 0
	}
	if width >= 64 {
		return ^uint64(0)
	}
	return uint64(1)<<width - 1
}

// bitWriter 以“低位在前”顺序把定宽位串追加到字节缓冲，尾部不足整字节处补零。
// 内部以两个 uint64 构成 128 位移位寄存器，保证一次写入最多 64 位时不溢出。
type bitWriter struct {
	buf    []byte
	lo, hi uint64
	nbits  int // 寄存器中有效位数（0..7，finish 之外每轮刷回该范围）
}

// writeBits 写入 value 的低 width 位；width 取 0..64。
func (w *bitWriter) writeBits(value uint64, width int) {
	if width == 0 {
		return
	}
	if width == 64 {
		// 拆成两个不超过 63 位的写，避免与已有偏移组合时移位 64 位。
		w.writeBits(value&lowMask(32), 32)
		w.writeBits(value>>32, 32)
		return
	}
	value &= lowMask(width)
	off := w.nbits
	w.lo |= value << off
	if off > 0 {
		w.hi |= value >> (64 - off)
	}
	w.nbits = off + width
	for w.nbits >= 8 {
		w.buf = append(w.buf, byte(w.lo))
		// 128 位整体右移 8 位：lo 的高位来自 hi 的低 8 位。
		w.lo = w.lo>>8 | (w.hi&0xff)<<56
		w.hi >>= 8
		w.nbits -= 8
	}
}

// finish 刷出剩余位（补零）并返回完整负载。
func (w *bitWriter) finish() []byte {
	if w.nbits > 0 {
		w.buf = append(w.buf, byte(w.lo))
		w.lo = 0
		w.hi = 0
		w.nbits = 0
	}
	return w.buf
}

// bitReader 按“低位在前”顺序从字节负载读取定宽位串。
type bitReader struct {
	data []byte
	pos  int // 已消费的比特总数
}

// newBitReader 构造读取器，并在负载尾部追加 8 个零字节作为松弛区，
// 保证最坏情况下的跨字节读取不会越界（超出真实负载的位读为 0）。
func newBitReader(payload []byte) bitReader {
	padded := make([]byte, len(payload)+8)
	copy(padded, payload)
	return bitReader{data: padded}
}

// readBits 读取 width 位（0..64）并以无符号原值返回。
func (r *bitReader) readBits(width int) uint64 {
	if width == 0 {
		return 0
	}
	bytePos := r.pos >> 3
	bitOff := r.pos & 7
	// 松弛区保证 bytePos+8 不越界；组合跨至多 9 字节的 64 位结果。
	lo := uint64(r.data[bytePos]) |
		uint64(r.data[bytePos+1])<<8 |
		uint64(r.data[bytePos+2])<<16 |
		uint64(r.data[bytePos+3])<<24 |
		uint64(r.data[bytePos+4])<<32 |
		uint64(r.data[bytePos+5])<<40 |
		uint64(r.data[bytePos+6])<<48 |
		uint64(r.data[bytePos+7])<<56
	next := uint64(r.data[bytePos+8])
	var value uint64
	if bitOff == 0 {
		value = lo
	} else {
		value = lo>>bitOff | next<<(64-bitOff)
	}
	r.pos += width
	return value & lowMask(width)
}
