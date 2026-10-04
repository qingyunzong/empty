package serialframe

import "bytes"

// Parser 为流式帧解析器，可任意切块喂入数据。
// 内部缓冲上界为 HeaderLen+maxPayload+CRCLen，不会随垃圾数据增长。
type Parser struct {
	maxPayload int
	buf        []byte
	discarded  int64
}

// NewParser 创建解析器；maxPayload 为允许的最大载荷字节数。
func NewParser(maxPayload int) *Parser {
	if maxPayload <= 0 {
		maxPayload = DefaultMaxPayload
	}
	return &Parser{maxPayload: maxPayload}
}

// Discarded 返回累计丢弃的字节数（垃圾、坏帧、超长帧头）。
func (p *Parser) Discarded() int64 { return p.discarded }

// Buffered 返回当前内部缓冲字节数，用于验证内存上界。
func (p *Parser) Buffered() int { return len(p.buf) }

// MaxBuffered 返回内部缓冲的理论上界。
func (p *Parser) MaxBuffered() int { return HeaderLen + p.maxPayload + CRCLen }

// Feed 喂入一块数据，返回本次解析出的完整帧。
// 帧的 Payload 为独立拷贝，调用方可安全持有。
func (p *Parser) Feed(data []byte) []Frame {
	p.buf = append(p.buf, data...)
	var frames []Frame
	for {
		i := bytes.Index(p.buf, Magic[:])
		if i < 0 {
			// 无魔数：仅保留末尾 len(Magic)-1 字节（可能是魔数前缀）。
			keep := len(Magic) - 1
			if len(p.buf) > keep {
				p.discarded += int64(len(p.buf) - keep)
				p.buf = append([]byte(nil), p.buf[len(p.buf)-keep:]...)
			}
			break
		}
		if i > 0 {
			p.discarded += int64(i)
			p.buf = p.buf[i:]
		}
		if len(p.buf) < HeaderLen {
			break // 头不完整，等待更多数据
		}
		length := int(p.buf[2])<<8 | int(p.buf[3])
		if length > p.maxPayload {
			// 超长：不分配缓冲，从魔数后一字节重搜。
			p.discarded++
			p.buf = p.buf[1:]
			continue
		}
		total := HeaderLen + length + CRCLen
		if len(p.buf) < total {
			break // 帧不完整，缓冲上界即 maxPayload 整帧
		}
		seq := p.buf[4]
		payload := p.buf[HeaderLen : HeaderLen+length]
		got := uint16(p.buf[total-2])<<8 | uint16(p.buf[total-1])
		if got != crc(uint16(length), seq, payload) {
			// CRC 错误：从魔数后一字节重搜（魔数可能在载荷中）。
			p.discarded++
			p.buf = p.buf[1:]
			continue
		}
		cp := make([]byte, length)
		copy(cp, payload)
		frames = append(frames, Frame{Seq: seq, Payload: cp})
		p.buf = p.buf[total:]
	}
	// 防退化：正常路径下 buf 已有上界，这里兜底压缩空闲容量。
	if len(p.buf) == 0 {
		p.buf = nil
	}
	return frames
}
