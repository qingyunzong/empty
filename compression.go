package dataeng

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

var ErrUnsupportedCompression = errors.New("dataeng: unsupported ORC compression codec")

const defaultCompressionBlockSize = 256 * 1024

// decompressStream decodes the chunk framing used by ORC. Every chunk is
// preceded by a three byte little-endian header. The low bit is the "original"
// flag and the remaining bits are the stored chunk length.
func decompressStream(data []byte, codec CompressionKind, blockSize uint64) ([]byte, error) {
	if codec == CompressionNone {
		return append([]byte(nil), data...), nil
	}
	if blockSize == 0 {
		blockSize = defaultCompressionBlockSize
	}
	var out bytes.Buffer
	for len(data) > 0 {
		if len(data) < 3 {
			return nil, errTruncatedProto
		}
		header := int(data[0]) | int(data[1])<<8 | int(data[2])<<16
		data = data[3:]
		length := header >> 1
		original := header&1 != 0
		if length < 0 || length > len(data) {
			return nil, errors.New("dataeng: corrupt ORC compression chunk")
		}
		chunk := data[:length]
		data = data[length:]
		if original {
			out.Write(chunk)
			continue
		}
		decoded, err := decompressChunk(chunk, codec, int(blockSize))
		if err != nil {
			return nil, err
		}
		out.Write(decoded)
	}
	return out.Bytes(), nil
}

func decompressChunk(chunk []byte, codec CompressionKind, blockSize int) ([]byte, error) {
	switch codec {
	case CompressionZlib:
		zr, err := zlib.NewReader(bytes.NewReader(chunk))
		if err != nil {
			return nil, fmt.Errorf("dataeng: zlib header: %w", err)
		}
		defer zr.Close()
		out, err := io.ReadAll(io.LimitReader(zr, int64(blockSize)+1))
		if err != nil {
			return nil, fmt.Errorf("dataeng: zlib data: %w", err)
		}
		if len(out) > blockSize {
			return nil, errors.New("dataeng: zlib chunk exceeds compression block size")
		}
		return out, nil
	case CompressionSnappy:
		return decodeSnappy(chunk, blockSize)
	case CompressionLz4:
		return decodeLZ4(chunk, blockSize)
	case CompressionZstd:
		return nil, fmt.Errorf("%w: ZSTD", ErrUnsupportedCompression)
	case CompressionLzo:
		return nil, fmt.Errorf("%w: LZO", ErrUnsupportedCompression)
	default:
		return nil, fmt.Errorf("%w: %d", ErrUnsupportedCompression, int32(codec))
	}
}

// decodeSnappy implements the raw Snappy block format used by ORC. It is not
// the Snappy framing format.
func decodeSnappy(src []byte, limit int) ([]byte, error) {
	n, used := binary.Uvarint(src)
	if used <= 0 {
		return nil, errors.New("dataeng: invalid snappy length")
	}
	if n > uint64(limit) {
		// Some writers do not reset the block size exactly; still cap absurd
		// allocations while allowing a small framing mismatch.
		if n > uint64(limit)+1<<20 {
			return nil, errors.New("dataeng: snappy output exceeds block size")
		}
	}
	dst := make([]byte, 0, int(n))
	src = src[used:]
	for len(src) > 0 {
		tag := src[0]
		src = src[1:]
		switch tag & 3 {
		case 0: // literal
			l := int(tag >> 2)
			if l < 60 {
				l++
			} else {
				extra := l - 59
				if len(src) < extra {
					return nil, errTruncatedProto
				}
				var v uint32
				for i := 0; i < extra; i++ {
					v |= uint32(src[i]) << (8 * i)
				}
				src = src[extra:]
				l = int(v) + 1
			}
			if l > len(src) {
				return nil, errTruncatedProto
			}
			dst = append(dst, src[:l]...)
			src = src[l:]
		case 1: // copy with 1-byte offset
			if len(src) < 1 {
				return nil, errTruncatedProto
			}
			l := 4 + int((tag>>2)&7)
			off := int(tag&0xe0)<<3 | int(src[0])
			src = src[1:]
			if err := snappyCopy(&dst, off, l); err != nil {
				return nil, err
			}
		case 2: // copy with 2-byte offset
			if len(src) < 2 {
				return nil, errTruncatedProto
			}
			l := 1 + int(tag>>2)
			off := int(src[0]) | int(src[1])<<8
			src = src[2:]
			if err := snappyCopy(&dst, off, l); err != nil {
				return nil, err
			}
		case 3: // copy with 4-byte offset
			if len(src) < 4 {
				return nil, errTruncatedProto
			}
			l := 1 + int(tag>>2)
			off := int(binary.LittleEndian.Uint32(src))
			src = src[4:]
			if err := snappyCopy(&dst, off, l); err != nil {
				return nil, err
			}
		}
	}
	if uint64(len(dst)) != n {
		return nil, fmt.Errorf("dataeng: snappy length mismatch: got %d want %d", len(dst), n)
	}
	return dst, nil
}

func snappyCopy(dst *[]byte, offset, length int) error {
	if offset <= 0 || offset > len(*dst) {
		return errors.New("dataeng: invalid snappy copy offset")
	}
	out := *dst
	start := len(out) - offset
	for i := 0; i < length; i++ {
		out = append(out, out[start+i])
	}
	*dst = out
	return nil
}

// decodeLZ4 implements a raw LZ4 block, which is what ORC uses for LZ4
// compressed chunks.
func decodeLZ4(src []byte, limit int) ([]byte, error) {
	dst := make([]byte, 0, limit)
	for len(src) > 0 {
		token := src[0]
		src = src[1:]
		literalLen := int(token >> 4)
		if literalLen == 15 {
			for {
				if len(src) == 0 {
					return nil, errTruncatedProto
				}
				b := src[0]
				src = src[1:]
				literalLen += int(b)
				if b != 255 {
					break
				}
			}
		}
		if literalLen > len(src) {
			return nil, errTruncatedProto
		}
		dst = append(dst, src[:literalLen]...)
		src = src[literalLen:]
		if len(src) == 0 {
			break
		}
		if len(src) < 2 {
			return nil, errTruncatedProto
		}
		offset := int(binary.LittleEndian.Uint16(src))
		src = src[2:]
		if offset <= 0 || offset > len(dst) {
			return nil, errors.New("dataeng: invalid LZ4 match offset")
		}
		matchLen := int(token & 0x0f)
		if matchLen == 15 {
			for {
				if len(src) == 0 {
					return nil, errTruncatedProto
				}
				b := src[0]
				src = src[1:]
				matchLen += int(b)
				if b != 255 {
					break
				}
			}
		}
		matchLen += 4
		start := len(dst) - offset
		for i := 0; i < matchLen; i++ {
			dst = append(dst, dst[start+i])
		}
		if len(dst) > limit {
			return nil, errors.New("dataeng: LZ4 output exceeds block size")
		}
	}
	return dst, nil
}
