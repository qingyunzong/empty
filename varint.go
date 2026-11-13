package dataeng

import "fmt"

func readVarint(data []byte, pos int) (int32, int, error) {
	var raw uint32
	for i := 0; i < 5; i++ {
		if pos+i >= len(data) {
			return 0, 0, fmt.Errorf("%w: varint at byte %d", ErrTruncated, pos)
		}
		b := data[pos+i]
		if i == 4 && b&0xf0 != 0 {
			return 0, 0, fmt.Errorf("%w: overlong 32-bit varint at byte %d", ErrInvalidVarint, pos)
		}
		raw |= uint32(b&0x7f) << (7 * i)
		if b&0x80 == 0 {
			value := int32(raw>>1) ^ -int32(raw&1)
			return value, i + 1, nil
		}
	}
	return 0, 0, fmt.Errorf("%w: unterminated 32-bit varint at byte %d", ErrInvalidVarint, pos)
}

func readVarlong(data []byte, pos int) (int64, int, error) {
	var raw uint64
	for i := 0; i < 10; i++ {
		if pos+i >= len(data) {
			return 0, 0, fmt.Errorf("%w: varlong at byte %d", ErrTruncated, pos)
		}
		b := data[pos+i]
		if i == 9 && b&0xfe != 0 {
			return 0, 0, fmt.Errorf("%w: overlong 64-bit varlong at byte %d", ErrInvalidVarint, pos)
		}
		raw |= uint64(b&0x7f) << (7 * i)
		if b&0x80 == 0 {
			value := int64(raw>>1) ^ -int64(raw&1)
			return value, i + 1, nil
		}
	}
	return 0, 0, fmt.Errorf("%w: unterminated 64-bit varlong at byte %d", ErrInvalidVarint, pos)
}
