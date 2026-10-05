package binmsg

import "fmt"

// RawField is a field occurrence located by Scan. It is produced by an
// independent boundary walker and used to cross-check Parse results.
type RawField struct {
	Offset int // offset of the tag byte
	Number int
	Wire   WireType
	End    int    // offset just past the field
	Raw    []byte // exact bytes of tag + payload
}

// Scan walks data and returns the raw boundaries of every field occurrence,
// without any schema. It is intentionally implemented as a standalone loop
// so tests can validate Parse against an independent implementation.
func Scan(data []byte) ([]RawField, error) {
	var out []RawField
	pos := 0
	for pos < len(data) {
		start := pos
		// Read tag varint.
		var tag uint64
		var shift uint
		for {
			if pos >= len(data) {
				return nil, &Error{Offset: start, Msg: "truncated varint"}
			}
			b := data[pos]
			pos++
			tag |= uint64(b&0x7f) << shift
			if b < 0x80 {
				break
			}
			shift += 7
			if shift >= 70 {
				return nil, &Error{Offset: start, Msg: "varint overflows 64 bits"}
			}
		}
		num := int(tag >> 3)
		wt := WireType(tag & 7)
		if num == 0 {
			return nil, &Error{Offset: start, Msg: "invalid field number 0"}
		}
		switch wt {
		case WireVarint:
			for {
				if pos >= len(data) {
					return nil, &Error{Offset: start, Msg: "truncated varint"}
				}
				b := data[pos]
				pos++
				if b < 0x80 {
					break
				}
			}
		case WireFixed64:
			if len(data)-pos < 8 {
				return nil, &Error{Offset: pos, Msg: "truncated fixed64"}
			}
			pos += 8
		case WireBytes:
			var n uint64
			var lshift uint
			for {
				if pos >= len(data) {
					return nil, &Error{Offset: start, Msg: "truncated varint"}
				}
				b := data[pos]
				pos++
				n |= uint64(b&0x7f) << lshift
				if b < 0x80 {
					break
				}
				lshift += 7
				if lshift >= 70 {
					return nil, &Error{Offset: start, Msg: "varint overflows 64 bits"}
				}
			}
			if n > uint64(len(data)-pos) {
				return nil, &Error{Offset: pos, Msg: fmt.Sprintf("length %d exceeds remaining input", n)}
			}
			pos += int(n)
		case WireFixed32:
			if len(data)-pos < 4 {
				return nil, &Error{Offset: pos, Msg: "truncated fixed32"}
			}
			pos += 4
		default:
			return nil, &Error{Offset: start, Msg: fmt.Sprintf("invalid wire type %d", int(wt))}
		}
		out = append(out, RawField{
			Offset: start,
			Number: num,
			Wire:   wt,
			End:    pos,
			Raw:    data[start:pos],
		})
	}
	return out, nil
}
