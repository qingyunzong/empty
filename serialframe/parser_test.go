package serialframe

import (
	"bytes"
	"fmt"
	"testing"
)

// feedInChunks 按给定切块大小喂入并汇总帧。
func feedInChunks(p *Parser, data []byte, chunk int) []Frame {
	var out []Frame
	for len(data) > 0 {
		n := chunk
		if n > len(data) {
			n = len(data)
		}
		out = append(out, p.Feed(data[:n])...)
		data = data[n:]
	}
	return out
}

func checkFrames(t *testing.T, got []Frame, want []Frame) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("帧数 = %d, 期望 %d", len(got), len(want))
	}
	for i := range want {
		if got[i].Seq != want[i].Seq || !bytes.Equal(got[i].Payload, want[i].Payload) {
			t.Fatalf("帧 %d = %+v, 期望 %+v", i, got[i], want[i])
		}
	}
}

// TestAllChunkPositions 对同一段字节流，枚举所有两段切分点及逐字节喂入，
// 验证解析结果一致。
func TestAllChunkPositions(t *testing.T) {
	f1 := Encode(1, []byte("hello"))
	f2 := Encode(2, []byte{0xAA, 0x55, 0xAA}) // 载荷内含魔数
	f3 := Encode(3, nil)                       // 空载荷
	stream := append(append(append([]byte{0x00, 0xFF, 0xAA}, f1...), f2...), f3...)
	want := []Frame{
		{Seq: 1, Payload: []byte("hello")},
		{Seq: 2, Payload: []byte{0xAA, 0x55, 0xAA}},
		{Seq: 3, Payload: []byte{}},
	}
	// 所有两段切分点
	for cut := 0; cut <= len(stream); cut++ {
		p := NewParser(64)
		got := p.Feed(stream[:cut])
		got = append(got, p.Feed(stream[cut:])...)
		checkFrames(t, got, want)
	}
	// 逐字节及多种块长
	for _, chunk := range []int{1, 2, 3, 7, len(stream)} {
		p := NewParser(64)
		checkFrames(t, feedInChunks(p, stream, chunk), want)
	}
}

// TestBadCRCRescan 坏 CRC 后从魔数后一字节重搜，能找到紧随其后的有效帧。
func TestBadCRCRescan(t *testing.T) {
	good := Encode(9, []byte("ok"))
	bad := Encode(8, []byte("bad"))
	bad[len(bad)-1] ^= 0xFF // 破坏 CRC
	stream := append(append([]byte{}, bad...), good...)
	for cut := 0; cut <= len(stream); cut++ {
		p := NewParser(64)
		got := p.Feed(stream[:cut])
		got = append(got, p.Feed(stream[cut:])...)
		checkFrames(t, got, []Frame{{Seq: 9, Payload: []byte("ok")}})
	}
}

// TestMagicInsideBadPayload 坏帧载荷内嵌魔数，重搜应从坏魔数+1 起，
// 且载荷中的伪魔数若构成合法帧也应被接受（按字节流语义）。
func TestMagicInsideBadPayload(t *testing.T) {
	inner := Encode(7, []byte("inner"))
	// 坏帧：载荷里嵌了一个完整合法帧，但自身 CRC 错误。
	bad := Encode(6, inner)
	bad[len(bad)-1] ^= 0x01
	p := NewParser(64)
	got := p.Feed(bad)
	// 外层 CRC 错 -> 从魔数+1 重搜 -> 载荷中的 inner 帧被解析出来。
	checkFrames(t, got, []Frame{{Seq: 7, Payload: []byte("inner")}})
}

// TestOversizeLength 长度超上限：不分配大缓冲，从魔数后一字节重搜，
// 后续有效帧正常解析。
func TestOversizeLength(t *testing.T) {
	const max = 16
	good := Encode(5, []byte("hi"))
	// 伪造头：魔数 + length=0xFFFF，远超上限。
	junk := []byte{Magic[0], Magic[1], 0xFF, 0xFF, 0x00, 0x11, 0x22}
	stream := append(append([]byte{}, junk...), good...)
	for cut := 0; cut <= len(stream); cut++ {
		p := NewParser(max)
		got := p.Feed(stream[:cut])
		got = append(got, p.Feed(stream[cut:])...)
		checkFrames(t, got, []Frame{{Seq: 5, Payload: []byte("hi")}})
		if p.Buffered() > p.MaxBuffered() {
			t.Fatalf("cut=%d 缓冲 %d 超过上界 %d", cut, p.Buffered(), p.MaxBuffered())
		}
	}
}

// TestMaxPayloadBoundary 载荷长度恰为上限时接受，超一字节则拒绝。
func TestMaxPayloadBoundary(t *testing.T) {
	const max = 8
	ok := Encode(1, bytes.Repeat([]byte{0x42}, max))
	tooBig := Encode(2, bytes.Repeat([]byte{0x42}, max+1))
	p := NewParser(max)
	got := p.Feed(append(append([]byte{}, tooBig...), ok...))
	checkFrames(t, got, []Frame{{Seq: 1, Payload: bytes.Repeat([]byte{0x42}, max)}})
}

// TestDiscardedCount 验证丢弃区间统计：前导垃圾 + 坏帧逐字节重搜丢弃。
func TestDiscardedCount(t *testing.T) {
	garbage := []byte{0x01, 0x02, 0x03}
	bad := Encode(1, []byte("xy"))
	bad[len(bad)-1] ^= 0xFF
	good := Encode(2, []byte("z"))
	stream := append(append(append([]byte{}, garbage...), bad...), good...)
	p := NewParser(64)
	got := p.Feed(stream)
	checkFrames(t, got, []Frame{{Seq: 2, Payload: []byte("z")}})
	// 坏帧 9 字节全部丢弃：CRC 错丢 1 字节后，剩余 8 字节中无魔数，作为垃圾丢弃。
	wantDiscarded := int64(len(garbage) + len(bad))
	if p.Discarded() != wantDiscarded {
		t.Fatalf("Discarded = %d, 期望 %d", p.Discarded(), wantDiscarded)
	}
}

// TestMemoryBound 喂入大量垃圾与伪帧头，缓冲始终有界。
func TestMemoryBound(t *testing.T) {
	p := NewParser(DefaultMaxPayload)
	bound := p.MaxBuffered()
	// 1MB 随机垃圾（确定性伪随机）。
	seed := uint32(12345)
	rnd := func() byte {
		seed = seed*1664525 + 1013904223
		return byte(seed >> 24)
	}
	chunk := make([]byte, 4096)
	for i := 0; i < 256; i++ {
		for j := range chunk {
			r := rnd()
			if r == Magic[0] { // 避免凑巧拼出长合法帧，干扰上界验证
				r = 0x00
			}
			chunk[j] = r
		}
		p.Feed(chunk)
		if p.Buffered() > bound {
			t.Fatalf("缓冲 %d 超过上界 %d", p.Buffered(), bound)
		}
	}
	// 大量"魔数+超长长度"伪头：每次都应立即丢弃而不累积。
	fake := []byte{Magic[0], Magic[1], 0xFF, 0xFF, 0x00}
	for i := 0; i < 100000; i++ {
		p.Feed(fake)
		if p.Buffered() > bound {
			t.Fatalf("伪头累积：缓冲 %d 超过上界 %d", p.Buffered(), bound)
		}
	}
	// 一个不完整的最大合法帧：缓冲可接近但不超上界。
	head := []byte{Magic[0], Magic[1], byte(DefaultMaxPayload >> 8), byte(DefaultMaxPayload & 0xFF), 0x01}
	p.Feed(head)
	p.Feed(make([]byte, DefaultMaxPayload/2))
	if p.Buffered() > bound {
		t.Fatalf("不完整帧缓冲 %d 超过上界 %d", p.Buffered(), bound)
	}
}

// TestFrameCopy 返回帧的载荷应为独立拷贝，不受后续 Feed 影响。
func TestFrameCopy(t *testing.T) {
	p := NewParser(64)
	got := p.Feed(Encode(1, []byte("keep")))
	p.Feed(Encode(2, bytes.Repeat([]byte{0x99}, 32)))
	if string(got[0].Payload) != "keep" {
		t.Fatalf("载荷被污染: %q", got[0].Payload)
	}
}

// TestManyFramesStream 连续多帧混合垃圾，逐字节喂入。
func TestManyFramesStream(t *testing.T) {
	var stream []byte
	var want []Frame
	for i := 0; i < 50; i++ {
		payload := []byte(fmt.Sprintf("msg-%02d", i))
		stream = append(stream, Encode(uint8(i), payload)...)
		want = append(want, Frame{Seq: uint8(i), Payload: payload})
		if i%3 == 0 {
			stream = append(stream, 0x00, 0xAA) // 散点垃圾
		}
	}
	p := NewParser(64)
	checkFrames(t, feedInChunks(p, stream, 1), want)
}
