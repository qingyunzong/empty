package lp1

import "encoding/binary"

// byteView abstracts byte inspection so validation (uncounted) and cursor
// traversal (counted through the snapshot's observable counter) share one
// implementation.
type byteView interface {
	at(data []byte, pos int) byte
	slice(data []byte, start, end int) []byte
}

// silentView reads validated bytes without touching any observable counter.
type silentView struct{}

func (silentView) at(data []byte, pos int) byte       { return data[pos] }
func (silentView) slice(data []byte, s, e int) []byte { return data[s:e] }

// countedView records every inspected page byte in the snapshot counter.
type countedView struct{ snap *Snapshot }

func (v *countedView) at(data []byte, pos int) byte {
	v.snap.byteReads.Add(1)
	return data[pos]
}

func (v *countedView) slice(data []byte, start, end int) []byte {
	v.snap.byteReads.Add(uint64(end - start))
	// Return a copy: callers must never mutate snapshot storage.
	out := make([]byte, end-start)
	copy(out, data[start:end])
	return out
}

// scanBody decodes one body starting at start. It returns the logical type, the
// integer value (for integers), a copy of the payload (for strings) and the
// total body length in bytes. Wide integer and string encodings are accepted;
// strings are never coerced into integers.
func scanBody(data []byte, start, limit int, view byteView) (kind Type, num int64, payload []byte, bodyLen int, ok bool) {
	if start >= limit {
		return 0, 0, nil, 0, false
	}
	b := view.at(data, start)
	switch {
	case b < 0x80:
		return TypeInteger, int64(b), nil, 1, true

	case b <= 0xbf:
		n := int(b & 0x3f)
		end := start + 1 + n
		if end > limit {
			return 0, 0, nil, 0, false
		}
		return TypeString, 0, view.slice(data, start+1, end), 1 + n, true

	case b <= 0xdf:
		if start+2 > limit {
			return 0, 0, nil, 0, false
		}
		lo := view.at(data, start+1)
		raw := int64(b&0x1f)<<8 | int64(lo)
		return TypeInteger, signExtend(raw, 13), nil, 2, true

	case b <= 0xef:
		if start+2 > limit {
			return 0, 0, nil, 0, false
		}
		lo := view.at(data, start+1)
		n := int(b&0x0f)<<8 | int(lo)
		end := start + 2 + n
		if end > limit {
			return 0, 0, nil, 0, false
		}
		return TypeString, 0, view.slice(data, start+2, end), 2 + n, true

	case b == 0xf0:
		if start+5 > limit {
			return 0, 0, nil, 0, false
		}
		n := int(binary.LittleEndian.Uint32(data[start+1 : start+5]))
		for i := 1; i <= 4; i++ {
			view.at(data, start+i)
		}
		end := start + 5 + n
		if end > limit {
			return 0, 0, nil, 0, false
		}
		return TypeString, 0, view.slice(data, start+5, end), 5 + n, true

	case b == 0xf1:
		if start+3 > limit {
			return 0, 0, nil, 0, false
		}
		raw := uint64(view.at(data, start+1)) | uint64(view.at(data, start+2))<<8
		return TypeInteger, signExtend(int64(raw), 16), nil, 3, true

	case b == 0xf2:
		if start+4 > limit {
			return 0, 0, nil, 0, false
		}
		raw := uint64(view.at(data, start+1)) |
			uint64(view.at(data, start+2))<<8 |
			uint64(view.at(data, start+3))<<16
		return TypeInteger, signExtend(int64(raw), 24), nil, 4, true

	case b == 0xf3:
		if start+5 > limit {
			return 0, 0, nil, 0, false
		}
		raw := uint64(view.at(data, start+1)) |
			uint64(view.at(data, start+2))<<8 |
			uint64(view.at(data, start+3))<<16 |
			uint64(view.at(data, start+4))<<24
		return TypeInteger, signExtend(int64(raw), 32), nil, 5, true

	case b == 0xf4:
		if start+9 > limit {
			return 0, 0, nil, 0, false
		}
		raw := uint64(view.at(data, start+1)) |
			uint64(view.at(data, start+2))<<8 |
			uint64(view.at(data, start+3))<<16 |
			uint64(view.at(data, start+4))<<24 |
			uint64(view.at(data, start+5))<<32 |
			uint64(view.at(data, start+6))<<40 |
			uint64(view.at(data, start+7))<<48 |
			uint64(view.at(data, start+8))<<56
		return TypeInteger, int64(raw), nil, 9, true

	default:
		// 0xf5..0xfe are illegal; 0xff is only the page footer.
		return 0, 0, nil, 0, false
	}
}

// signExtend sign-extends a width-bit unsigned value held in raw.
func signExtend(raw int64, width uint) int64 {
	bit := int64(1) << (width - 1)
	return (raw ^ bit) - bit
}

// readBacklenBackward reads a reverse-length field ending immediately before
// boundary, walking left until a byte with high bit 0. It returns the body
// start, the decoded body length L and the field width. At most five bytes are
// consumed.
func readBacklenBackward(data []byte, boundary int, view byteView) (bodyStart, length, fieldWidth int, ok bool) {
	value := uint64(0)
	shift := uint(0)
	pos := boundary - 1
	for n := 0; n < maxBacklen; n++ {
		if pos < headerSize {
			return 0, 0, 0, false
		}
		g := view.at(data, pos)
		value |= uint64(g&0x7f) << shift
		shift += 7
		pos--
		if g&0x80 == 0 {
			width := n + 1
			if value == 0 {
				return 0, 0, 0, false
			}
			start := pos + 1 - int(value)
			if start < headerSize {
				return 0, 0, 0, false
			}
			return start, int(value), width, true
		}
	}
	return 0, 0, 0, false
}

// resolveBacklen validates the reverse-length field of an element whose body
// begins at bodyStart and spans bodyLen bytes, ending no later than limit. The
// field cannot be parsed forward unambiguously (continuation bytes may look like
// body bytes), so each of the five possible field widths is tested; exactly one
// minimal field can decode to the known body length and land on the body start.
// This rejects forged pages whose reverse field lands inside a payload.
func resolveBacklen(data []byte, bodyStart, bodyLen, limit int, view byteView) (elemEnd, fieldWidth int, ok bool) {
	bodyEnd := bodyStart + bodyLen
	matches := 0
	var foundEnd, foundWidth int
	for width := 1; width <= maxBacklen; width++ {
		fieldStart := bodyEnd
		fieldEnd := fieldStart + width
		if fieldEnd > limit {
			continue
		}
		decoded, valid := decodeBacklenField(data, fieldStart, width)
		if !valid || decoded != bodyLen {
			continue
		}
		start, gotLen, gotWidth, backwardOK := readBacklenBackward(data, fieldEnd, view)
		if !backwardOK || gotWidth != width || gotLen != bodyLen || start != bodyStart {
			continue
		}
		matches++
		foundEnd, foundWidth = fieldEnd, width
	}
	if matches != 1 {
		return 0, 0, false
	}
	return foundEnd, foundWidth, true
}

// decodeBacklenField decodes a fixed-width reverse-length field at fieldStart
// and enforces minimal encoding: first byte high bit 0, remaining bytes high
// bit 1, no redundant leading zero group and a non-zero result.
func decodeBacklenField(data []byte, fieldStart, width int) (int, bool) {
	if width < 1 || width > maxBacklen {
		return 0, false
	}
	first := data[fieldStart]
	if first&0x80 != 0 || first == 0 {
		return 0, false
	}
	value := uint64(first & 0x7f)
	for i := 1; i < width; i++ {
		g := data[fieldStart+i]
		if g&0x80 == 0 {
			return 0, false
		}
		value = value<<7 | uint64(g&0x7f)
	}
	if value == 0 || value > uint64(maxPageSize) {
		return 0, false
	}
	return int(value), true
}
