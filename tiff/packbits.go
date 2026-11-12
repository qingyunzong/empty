package tiff

import "fmt"

// decodePackBits decodes one compressed strip.
//
// lineBytes is the number of decoded bytes per image row and rows is the
// number of rows carried by the strip (the final strip may be short). Every
// literal copy or run must finish exactly on a row boundary, the no-op header
// -128 produces no bytes, and the decoded length must equal rows*lineBytes.
func decodePackBits(src []byte, lineBytes, rows int) ([]byte, error) {
	if lineBytes <= 0 || rows <= 0 {
		return nil, fmt.Errorf("tiff: invalid PackBits dimensions %d rows x %d bytes", rows, lineBytes)
	}
	expected, err := mulInt(rows, lineBytes)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 0, expected)
	pos := 0
	for pos < len(src) {
		n := int(int8(src[pos]))
		pos++
		switch {
		case n == -128:
			// No-op: emits nothing.
		case n >= 0:
			count := n + 1
			if pos+count > len(src) {
				return nil, fmt.Errorf("tiff: PackBits literal of %d bytes at input %d is truncated", count, pos-1)
			}
			if lineBytes == 0 || len(out)%lineBytes+count > lineBytes {
				return nil, fmt.Errorf("tiff: PackBits literal crosses row boundary at input %d", pos-1)
			}
			out = append(out, src[pos:pos+count]...)
			pos += count
		default:
			run := 1 - n
			if pos >= len(src) {
				return nil, fmt.Errorf("tiff: PackBits run at input %d is truncated", pos-1)
			}
			if lineBytes == 0 || len(out)%lineBytes+run > lineBytes {
				return nil, fmt.Errorf("tiff: PackBits run crosses row boundary at input %d", pos-1)
			}
			value := src[pos]
			pos++
			for j := 0; j < run; j++ {
				out = append(out, value)
			}
		}
		if len(out) > expected {
			return nil, fmt.Errorf("tiff: PackBits output exceeds expected %d bytes", expected)
		}
	}
	if len(out) != expected {
		return nil, fmt.Errorf("tiff: PackBits decoded %d bytes, expected %d", len(out), expected)
	}
	return out, nil
}
