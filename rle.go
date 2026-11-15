package dataeng

import (
	"fmt"
	"math"
)

// decodeInts decodes a complete ORC integer stream. String lengths and
// dictionary indices are unsigned. The stream is fully validated up front so
// that malformed input is reported by the decoder constructor rather than in
// the middle of a scan.
func decodeInts(data []byte, v2, signed bool) ([]int64, error) {
	if v2 {
		return decodeIntsV2(data, signed)
	}
	return decodeIntsV1(data, signed)
}

func decodeIntsV1(data []byte, signed bool) ([]int64, error) {
	values := make([]int64, 0, len(data))
	pos := 0
	for pos < len(data) {
		control := int(data[pos])
		pos++
		if control < 0x80 {
			// A run of (control + 3) values with a fixed signed delta.
			count := control + 3
			if pos >= len(data) {
				return nil, corruptf("RLEv1 run is missing its delta")
			}
			delta := int64(int8(data[pos]))
			pos++
			first, err := readVarint(data, &pos, signed)
			if err != nil {
				return nil, corruptf("RLEv1 run base: %v", err)
			}
			for i := 0; i < count; i++ {
				value := first + int64(i)*delta
				if (delta > 0 && value < first) || (delta < 0 && value > first) {
					return nil, corruptf("RLEv1 run overflows int64")
				}
				values = append(values, value)
			}
			continue
		}

		// A literal list containing (256 - control) varints.
		count := 256 - control
		for i := 0; i < count; i++ {
			value, err := readVarint(data, &pos, signed)
			if err != nil {
				return nil, corruptf("RLEv1 literal %d: %v", i, err)
			}
			values = append(values, value)
		}
	}
	return values, nil
}

func decodeIntsV2(data []byte, signed bool) ([]int64, error) {
	r := &v2Reader{data: data, signed: signed}
	values := make([]int64, 0, len(data))
	for r.pos < len(r.data) {
		chunk, err := r.readChunk()
		if err != nil {
			return nil, err
		}
		values = append(values, chunk...)
	}
	return values, nil
}

type v2Reader struct {
	data   []byte
	pos    int
	bit    uint
	signed bool
}

func (r *v2Reader) align() {
	if r.bit != 0 {
		r.pos++
		r.bit = 0
	}
}

func (r *v2Reader) readByte() (byte, error) {
	if r.bit != 0 {
		return 0, corruptf("RLEv2 byte read at bit offset %d", r.bit)
	}
	if r.pos >= len(r.data) {
		return 0, corruptf("RLEv2 stream is truncated")
	}
	b := r.data[r.pos]
	r.pos++
	return b, nil
}

func (r *v2Reader) readBE(n int) (uint64, error) {
	if n < 1 || n > 8 {
		return 0, corruptf("RLEv2 fixed value width %d", n)
	}
	if r.bit != 0 {
		return 0, corruptf("RLEv2 fixed value is not byte aligned")
	}
	if len(r.data)-r.pos < n {
		return 0, corruptf("RLEv2 fixed value is truncated")
	}
	var value uint64
	for i := 0; i < n; i++ {
		value = value<<8 | uint64(r.data[r.pos+i])
	}
	r.pos += n
	return value, nil
}

func (r *v2Reader) readBits(width int) (uint64, error) {
	if width == 0 {
		return 0, nil
	}
	if width < 0 || width > 64 {
		return 0, corruptf("RLEv2 bit width %d", width)
	}
	var value uint64
	left := width
	for left > 0 {
		if r.pos >= len(r.data) {
			return 0, corruptf("RLEv2 bit-packed values are truncated")
		}
		available := 8 - int(r.bit)
		take := available
		if take > left {
			take = left
		}
		shift := available - take
		mask := byte((1<<uint(take) - 1) << uint(shift))
		value = value<<uint(take) | uint64((r.data[r.pos]&mask)>>uint(shift))
		r.bit += uint(take)
		if r.bit == 8 {
			r.pos++
			r.bit = 0
		}
		left -= take
	}
	return value, nil
}

func (r *v2Reader) readPacked(width, count int) ([]uint64, error) {
	out := make([]uint64, count)
	for i := range out {
		value, err := r.readBits(width)
		if err != nil {
			return nil, err
		}
		out[i] = value
	}
	r.align()
	return out, nil
}

func (r *v2Reader) readChunk() ([]int64, error) {
	first, err := r.readByte()
	if err != nil {
		return nil, err
	}
	kind := first >> 6

	switch kind {
	case 0: // short repeat
		width := int((first>>3)&0x07) + 1
		count := int(first&0x07) + 3
		value, err := r.readBE(width)
		if err != nil {
			return nil, err
		}
		var signedValue int64
		if r.signed {
			signedValue = zigzagDecode(int64(value))
		} else {
			signedValue, err = asInt64(value)
			if err != nil {
				return nil, err
			}
		}
		out := make([]int64, count)
		for i := range out {
			out[i] = signedValue
		}
		return out, nil

	case 1: // direct
		width, err := decodeBitWidth(uint64((first >> 1) & 0x1f))
		if err != nil {
			return nil, err
		}
		second, err := r.readByte()
		if err != nil {
			return nil, err
		}
		count := (int(first&0x01)<<8 | int(second)) + 1
		packed, err := r.readPacked(width, count)
		if err != nil {
			return nil, err
		}
		out := make([]int64, count)
		for i, raw := range packed {
			if r.signed {
				out[i] = zigzagDecode(int64(raw))
			} else {
				out[i], err = asInt64(raw)
				if err != nil {
					return nil, err
				}
			}
		}
		return out, nil

	case 2: // patched base
		width, err := decodeBitWidth(uint64((first >> 1) & 0x1f))
		if err != nil {
			return nil, err
		}
		second, err := r.readByte()
		if err != nil {
			return nil, err
		}
		count := (int(first&0x01)<<8 | int(second)) + 1

		third, err := r.readByte()
		if err != nil {
			return nil, err
		}
		baseWidth := int(third>>5) + 1
		patchWidth, err := decodeBitWidth(uint64(third & 0x1f))
		if err != nil {
			return nil, err
		}
		fourth, err := r.readByte()
		if err != nil {
			return nil, err
		}
		patchGapWidth := int((fourth>>5)&0x07) + 1
		patchCount := int(fourth & 0x1f)

		rawBase, err := r.readBE(baseWidth)
		if err != nil {
			return nil, err
		}
		base := int64(rawBase)
		sign := uint64(1) << uint(baseWidth*8-1)
		if rawBase&sign != 0 {
			base = -int64(rawBase &^ sign)
		}

		packed, err := r.readPacked(width, count)
		if err != nil {
			return nil, err
		}

		patchTotalWidth := patchWidth + patchGapWidth
		if patchTotalWidth > 64 {
			return nil, corruptf("RLEv2 patched-base width is too large")
		}
		patches, err := r.readPacked(patchTotalWidth, patchCount)
		if err != nil {
			return nil, err
		}

		out := make([]int64, count)
		for i, raw := range packed {
			value, err := addInt64(base, raw)
			if err != nil {
				return nil, err
			}
			out[i] = value
		}
		if patchCount > 0 {
			if width >= 63 {
				return nil, corruptf("RLEv2 patched-base patch shift %d", width)
			}
			if width+patchWidth > 64 {
				return nil, corruptf("RLEv2 patched-base value width is too large")
			}
			var patchMask uint64
			if patchWidth == 64 {
				patchMask = math.MaxUint64
			} else {
				patchMask = (uint64(1) << uint(patchWidth)) - 1
			}

			patchIndex := 0
			gap := int64(patches[0] >> uint(patchWidth))
			patch := patches[0] & patchMask
			target := int64(0)
			for {
				for gap == 255 && patch == 0 {
					target += 255
					patchIndex++
					if patchIndex >= len(patches) {
						return nil, corruptf("RLEv2 patch gap continues past patch list")
					}
					gap = int64(patches[patchIndex] >> uint(patchWidth))
					patch = patches[patchIndex] & patchMask
				}
				target += gap
				if target < 0 || target >= int64(len(out)) {
					return nil, corruptf("RLEv2 patch index %d outside run", target)
				}
				if patch > math.MaxUint64>>uint(width) {
					return nil, corruptf("RLEv2 patch value overflows")
				}
				high, err := addInt64(out[target], patch<<uint(width))
				if err != nil {
					return nil, err
				}
				out[target] = high

				patchIndex++
				if patchIndex >= len(patches) {
					break
				}
				gap = int64(patches[patchIndex] >> uint(patchWidth))
				patch = patches[patchIndex] & patchMask
				target++
			}
		}
		return out, nil

	case 3: // delta
		widthCode := uint64((first >> 1) & 0x1f)
		var width int
		if widthCode != 0 {
			width, err = decodeBitWidth(widthCode)
			if err != nil {
				return nil, err
			}
		}
		second, err := r.readByte()
		if err != nil {
			return nil, err
		}
		count := (int(first&0x01)<<8 | int(second)) + 1

		base, err := r.readVarint()
		if err != nil {
			return nil, err
		}
		if count == 1 {
			return []int64{base}, nil
		}
		deltaBase, err := r.readSignedVarint()
		if err != nil {
			return nil, err
		}

		out := make([]int64, count)
		out[0] = base
		next, ok := addChecked(base, deltaBase)
		if !ok {
			return nil, corruptf("RLEv2 delta overflows int64")
		}
		out[1] = next
		if width == 0 {
			for i := 2; i < count; i++ {
				next, ok := addChecked(out[i-1], deltaBase)
				if !ok {
					return nil, corruptf("RLEv2 delta overflows int64")
				}
				out[i] = next
			}
		} else {
			for i := 2; i < count; i++ {
				raw, err := r.readBits(width)
				if err != nil {
					return nil, err
				}
				var delta int64
				if r.signed {
					delta = zigzagDecode(int64(raw))
				} else {
					delta = int64(raw)
					if deltaBase < 0 {
						delta = -delta
					}
				}
				next, ok := addChecked(out[i-1], delta)
				if !ok {
					return nil, corruptf("RLEv2 delta overflows int64")
				}
				out[i] = next
			}
		}
		r.align()
		return out, nil
	}

	return nil, corruptf("unknown RLEv2 encoding %d", kind)
}

func (r *v2Reader) readVarint() (int64, error) {
	value, err := readUVarint(r.data, &r.pos)
	if err != nil {
		return 0, err
	}
	if r.signed {
		return zigzagDecode(int64(value)), nil
	}
	return asInt64(value)
}

func (r *v2Reader) readSignedVarint() (int64, error) {
	value, err := readUVarint(r.data, &r.pos)
	if err != nil {
		return 0, err
	}
	return zigzagDecode(int64(value)), nil
}

func readVarint(data []byte, pos *int, signed bool) (int64, error) {
	value, err := readUVarint(data, pos)
	if err != nil {
		return 0, err
	}
	if signed {
		return zigzagDecode(int64(value)), nil
	}
	return asInt64(value)
}

func readUVarint(data []byte, pos *int) (uint64, error) {
	var value uint64
	var shift uint
	for i := 0; i < 10; i++ {
		if *pos >= len(data) {
			return 0, corruptf("truncated varint")
		}
		b := data[*pos]
		*pos++
		if i == 9 && b > 1 {
			return 0, corruptf("varint overflows uint64")
		}
		value |= uint64(b&0x7f) << shift
		if b < 0x80 {
			return value, nil
		}
		shift += 7
	}
	return 0, corruptf("varint is too long")
}

func zigzagDecode(v int64) int64 {
	return int64(uint64(v)>>1) ^ -int64(v&1)
}

func zigzagEncode(v int64) uint64 {
	return uint64(v<<1) ^ uint64(v>>63)
}

// decodeBitWidth maps the ORC 5-bit width table onto a number of bits.
func decodeBitWidth(encoded uint64) (int, error) {
	if encoded < 24 {
		return int(encoded) + 1, nil
	}
	table := [...]int{26, 28, 30, 32, 40, 48, 56, 64}
	if encoded < 24+uint64(len(table)) {
		return table[encoded-24], nil
	}
	return 0, corruptf("invalid ORC bit-width code %d", encoded)
}

// encodeBitWidth is the inverse of decodeBitWidth.
func encodeBitWidth(width int) (uint64, error) {
	if width < 1 || width > 64 {
		return 0, corruptf("invalid bit width %d", width)
	}
	if width <= 24 {
		return uint64(width - 1), nil
	}
	table := [...]int{26, 28, 30, 32, 40, 48, 56, 64}
	for i, candidate := range table {
		if candidate == width {
			return uint64(24 + i), nil
		}
	}
	return 0, corruptf("bit width %d is not representable", width)
}

func asInt64(value uint64) (int64, error) {
	if value > math.MaxInt64 {
		return 0, corruptf("integer %d overflows int64", value)
	}
	return int64(value), nil
}

func addInt64(base int64, unsignedDelta uint64) (int64, error) {
	if unsignedDelta > math.MaxInt64 {
		return 0, corruptf("integer delta overflows int64")
	}
	delta := int64(unsignedDelta)
	value, ok := addChecked(base, delta)
	if !ok {
		return 0, corruptf("integer addition overflows int64")
	}
	return value, nil
}

func addChecked(a, b int64) (int64, bool) {
	if b > 0 && a > math.MaxInt64-b {
		return 0, false
	}
	if b < 0 && a < math.MinInt64-b {
		return 0, false
	}
	return a + b, true
}

func corruptf(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrCorrupt, fmt.Sprintf(format, args...))
}
