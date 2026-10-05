// Package lzw implements LZW compression with an explicit initial
// dictionary, growing code widths and a clear code, plus verified
// checkpoints for random-access (range) decoding.
//
// Format:
//   - The initial dictionary maps codes 0..255 to single bytes.
//   - Code 256 is the clear code; it resets the dictionary to the initial
//     state. There is no end-of-stream code: the stream ends at a code
//     boundary, zero-padded to a whole byte.
//   - Codes 257 and up are dictionary entries built during compression.
//   - Codes are packed LSB-first. The code width starts at 9 bits and
//     grows by one bit whenever the next unassigned code reaches
//     1<<width, up to 16 bits. When the dictionary is full (the next
//     code would exceed 65535) the encoder emits a clear code, at the
//     current 16-bit width, and starts over.
package lzw

import (
	"errors"
	"io"
)

const (
	ClearCode = 256
	FirstCode = 257
	MinWidth  = 9
	MaxWidth  = 16
	MaxCode   = 1<<MaxWidth - 1
	dictSize  = 1 << MaxWidth
)

var (
	ErrInvalidCode        = errors.New("lzw: invalid code")
	ErrTrailingBits       = errors.New("lzw: trailing bits after final code")
	ErrDictOverflow       = errors.New("lzw: dictionary overflow without clear code")
	ErrCheckpointMismatch = errors.New("lzw: checkpoint does not match source prefix")
)

// widthForNext returns the code width in effect while the next
// unassigned dictionary code is next.
func widthForNext(next int) int {
	w := MinWidth
	for w < MaxWidth && next > (1<<w)-1 {
		w++
	}
	return w
}

// Encode compresses src using the format described above.
func Encode(src []byte) []byte {
	if len(src) == 0 {
		return nil
	}
	w := bitWriter{}
	dict := make(map[uint32]int)
	next := FirstCode
	width := MinWidth
	prev := int(src[0])
	for _, b := range src[1:] {
		key := uint32(prev)<<8 | uint32(b)
		if code, ok := dict[key]; ok {
			prev = code
			continue
		}
		w.write(prev, width)
		dict[key] = next
		next++
		if next == 1<<width && width < MaxWidth {
			width++
		}
		if next > MaxCode {
			w.write(ClearCode, width)
			dict = make(map[uint32]int)
			next = FirstCode
			width = MinWidth
		}
		prev = int(b)
	}
	w.write(prev, width)
	w.flush()
	return w.buf
}

// Decode decompresses src. It reports ErrInvalidCode for codes the
// dictionary cannot explain, ErrTrailingBits for non-zero or over-long
// padding after the final code, and ErrDictOverflow for streams that
// keep adding entries past a full dictionary without a clear code.
func Decode(src []byte) ([]byte, error) {
	d := NewDecoder(src)
	var out []byte
	for {
		seg, err := d.step()
		if err == io.EOF {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		out = append(out, seg...)
	}
}
