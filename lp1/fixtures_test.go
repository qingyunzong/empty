package lp1_test

import (
	"encoding/binary"
	"errors"

	"example.org/dataeng/q0317/lp1"
)

// This file is an independent test fixture: it rebuilds the LP1 codec from the
// written specification without calling any package-private helper. Only the
// exported Value type and its constructors are shared with the library.

const (
	fixHeaderSize = 6
	fixFooterSize = 1
	fixFooter     = byte(0xff)
)

// fixValue mirrors lp1.Value inside the independent model.
type fixValue struct {
	kind lp1.Type
	num  int64
	str  []byte
}

func fixInteger(n int64) fixValue { return fixValue{kind: lp1.TypeInteger, num: n} }
func fixString(b []byte) fixValue {
	return fixValue{kind: lp1.TypeString, str: append([]byte(nil), b...)}
}

func (v fixValue) toValue() lp1.Value {
	if v.kind == lp1.TypeInteger {
		return lp1.Integer(v.num)
	}
	return lp1.String(v.str)
}

func fixEqual(v fixValue, got lp1.Value) bool {
	if v.kind != got.Type() {
		return false
	}
	if v.kind == lp1.TypeInteger {
		return v.num == got.Int()
	}
	g := got.Bytes()
	if len(g) != len(v.str) {
		return false
	}
	for i := range g {
		if g[i] != v.str[i] {
			return false
		}
	}
	return true
}

// fixEncodeInt emits an integer body at a chosen width. width 0 means shortest.
// Non-zero widths let tests construct deliberately non-shortest encodings,
// which Open must accept and Splice must preserve byte-for-byte.
func fixEncodeInt(n int64, width int) ([]byte, bool) {
	switch width {
	case 0:
		switch {
		case n >= 0 && n <= 127:
			return []byte{byte(n)}, true
		case n >= -4096 && n <= 4095:
			return fixEncodeInt(n, 13)
		case n >= -32768 && n <= 32767:
			return fixEncodeInt(n, 16)
		case n >= -8388608 && n <= 8388607:
			return fixEncodeInt(n, 24)
		case n >= -2147483648 && n <= 2147483647:
			return fixEncodeInt(n, 32)
		default:
			return fixEncodeInt(n, 64)
		}
	case 8:
		if n < 0 || n > 127 {
			return nil, false
		}
		return []byte{byte(n)}, true
	case 13:
		if n < -4096 || n > 4095 {
			return nil, false
		}
		u := uint16(n) & 0x1fff
		return []byte{0xc0 | byte(u>>8), byte(u)}, true
	case 16:
		if n < -32768 || n > 32767 {
			return nil, false
		}
		u := uint16(n)
		return []byte{0xf1, byte(u), byte(u >> 8)}, true
	case 24:
		if n < -8388608 || n > 8388607 {
			return nil, false
		}
		u := uint32(n)
		return []byte{0xf2, byte(u), byte(u >> 8), byte(u >> 16)}, true
	case 32:
		if n < -2147483648 || n > 2147483647 {
			return nil, false
		}
		u := uint32(n)
		return []byte{0xf3, byte(u), byte(u >> 8), byte(u >> 16), byte(u >> 24)}, true
	case 64:
		u := uint64(n)
		return []byte{
			0xf4,
			byte(u), byte(u >> 8), byte(u >> 16), byte(u >> 24),
			byte(u >> 32), byte(u >> 40), byte(u >> 48), byte(u >> 56),
		}, true
	default:
		return nil, false
	}
}

// fixEncodeString emits a string body using the requested prefix width:
// 6, 14 or 32 address the 6-bit, 12-bit and 32-bit length prefixes.
func fixEncodeString(payload []byte, prefixBits int) ([]byte, bool) {
	n := len(payload)
	switch prefixBits {
	case 6:
		if n > 63 {
			return nil, false
		}
		out := append([]byte{0x80 | byte(n)}, payload...)
		return out, true
	case 14:
		if n > 4095 {
			return nil, false
		}
		out := []byte{0xe0 | byte(n>>8), byte(n)}
		return append(out, payload...), true
	case 32:
		out := []byte{0xf0,
			byte(n), byte(n >> 8), byte(n >> 16), byte(n >> 24)}
		return append(out, payload...), true
	default:
		return nil, false
	}
}

// fixEncodeBacklen is the independent encoder for reverse lengths.
func fixEncodeBacklen(l int) []byte {
	var groups [5]byte
	n := 0
	for v := l; v != 0; v >>= 7 {
		groups[n] = byte(v & 0x7f)
		n++
	}
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		g := groups[n-1-i]
		if i > 0 {
			g |= 0x80
		}
		out[i] = g
	}
	return out
}

// fixElement is one on-page element in the independent list model. raw holds
// its full body+backlen encoding so byte preservation can be asserted.
type fixElement struct {
	value fixValue
	raw   []byte
}

func fixBuildElement(body []byte) fixElement {
	raw := append(append([]byte(nil), body...), fixEncodeBacklen(len(body))...)
	el := fixElement{raw: raw}
	if v, _, ok := fixDecodeElement(raw, 0, len(raw)); ok {
		el.value = v
	}
	return el
}

// fixBuildPage serialises a full LP1 page independently of the library.
// unknownCount stores 65535 in the header regardless of the real count.
func fixBuildPage(elems []fixElement, unknownCount bool) []byte {
	content := 0
	for _, e := range elems {
		content += len(e.raw)
	}
	total := fixHeaderSize + content + fixFooterSize
	page := make([]byte, total)
	binary.LittleEndian.PutUint32(page[0:4], uint32(total))
	if unknownCount {
		binary.LittleEndian.PutUint16(page[4:6], 65535)
	} else {
		binary.LittleEndian.PutUint16(page[4:6], uint16(len(elems)))
	}
	off := fixHeaderSize
	for _, e := range elems {
		off += copy(page[off:], e.raw)
	}
	page[total-1] = fixFooter
	return page
}

// fixDecodeElement parses one body independently and returns value and body
// length. It accepts wide encodings and keeps integers and strings distinct.
func fixDecodeElement(page []byte, start, limit int) (fixValue, int, bool) {
	if start >= limit {
		return fixValue{}, 0, false
	}
	b := page[start]
	switch {
	case b < 0x80:
		return fixInteger(int64(b)), 1, true
	case b <= 0xbf:
		n := int(b & 0x3f)
		end := start + 1 + n
		if end > limit {
			return fixValue{}, 0, false
		}
		return fixString(page[start+1 : end]), 1 + n, true
	case b <= 0xdf:
		if start+2 > limit {
			return fixValue{}, 0, false
		}
		raw := int64(b&0x1f)<<8 | int64(page[start+1])
		bit := int64(1) << 12
		return fixInteger((raw ^ bit) - bit), 2, true
	case b <= 0xef:
		if start+2 > limit {
			return fixValue{}, 0, false
		}
		n := int(b&0x0f)<<8 | int(page[start+1])
		end := start + 2 + n
		if end > limit {
			return fixValue{}, 0, false
		}
		return fixString(page[start+2 : end]), 2 + n, true
	case b == 0xf0:
		if start+5 > limit {
			return fixValue{}, 0, false
		}
		n := int(binary.LittleEndian.Uint32(page[start+1 : start+5]))
		end := start + 5 + n
		if end > limit {
			return fixValue{}, 0, false
		}
		return fixString(page[start+5 : end]), 5 + n, true
	case b == 0xf1:
		if start+3 > limit {
			return fixValue{}, 0, false
		}
		raw := int64(page[start+1]) | int64(page[start+2])<<8
		bit := int64(1) << 15
		return fixInteger((raw ^ bit) - bit), 3, true
	case b == 0xf2:
		if start+4 > limit {
			return fixValue{}, 0, false
		}
		raw := int64(page[start+1]) | int64(page[start+2])<<8 |
			int64(page[start+3])<<16
		bit := int64(1) << 23
		return fixInteger((raw ^ bit) - bit), 4, true
	case b == 0xf3:
		if start+5 > limit {
			return fixValue{}, 0, false
		}
		raw := int64(page[start+1]) | int64(page[start+2])<<8 |
			int64(page[start+3])<<16 | int64(page[start+4])<<24
		bit := int64(1) << 31
		return fixInteger((raw ^ bit) - bit), 5, true
	case b == 0xf4:
		if start+9 > limit {
			return fixValue{}, 0, false
		}
		raw := binary.LittleEndian.Uint64(append([]byte(nil), page[start+1:start+9]...))
		return fixInteger(int64(raw)), 9, true
	default:
		return fixValue{}, 0, false
	}
}

// fixReadBacklenBackward mirrors the required backward reader.
func fixReadBacklenBackward(page []byte, boundary int) (bodyStart, length, width int, ok bool) {
	value := 0
	shift := uint(0)
	pos := boundary - 1
	for n := 0; n < 5; n++ {
		if pos < fixHeaderSize {
			return 0, 0, 0, false
		}
		g := page[pos]
		value |= int(g&0x7f) << shift
		shift += 7
		pos--
		if g&0x80 == 0 {
			if value == 0 {
				return 0, 0, 0, false
			}
			return pos + 1 - value, value, n + 1, true
		}
	}
	return 0, 0, 0, false
}

// fixDecodePage is the independent full-decode list model.
func fixDecodePage(page []byte) ([]fixElement, error) {
	if len(page) < fixHeaderSize+fixFooterSize {
		return nil, errors.New("too short")
	}
	if binary.LittleEndian.Uint32(page[0:4]) != uint32(len(page)) {
		return nil, errors.New("total length mismatch")
	}
	if page[len(page)-1] != fixFooter {
		return nil, errors.New("bad footer")
	}
	hdr := binary.LittleEndian.Uint16(page[4:6])
	contentEnd := len(page) - fixFooterSize
	off := fixHeaderSize
	var out []fixElement
	for off < contentEnd {
		start := off
		val, bodyLen, ok := fixDecodeElement(page, start, contentEnd)
		if !ok {
			return nil, errors.New("bad body")
		}
		bodyEnd := start + bodyLen
		// Try each reverse-field width independently.
		matched := false
		for width := 1; width <= 5; width++ {
			fieldEnd := bodyEnd + width
			if fieldEnd > contentEnd {
				continue
			}
			gotStart, gotLen, gotWidth, backwardOK := fixReadBacklenBackward(page, fieldEnd)
			if backwardOK && gotWidth == width && gotLen == bodyLen && gotStart == start {
				out = append(out, fixElement{value: val, raw: append([]byte(nil), page[start:fieldEnd]...)})
				off = fieldEnd
				matched = true
				break
			}
		}
		if !matched {
			return nil, errors.New("bad reverse length")
		}
	}
	if hdr != 65535 && int(hdr) != len(out) {
		return nil, errors.New("header count mismatch")
	}
	return out, nil
}
