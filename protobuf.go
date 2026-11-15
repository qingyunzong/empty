package dataeng

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Protobuf wire types used by ORC's metadata.
const (
	wireVarint  = 0
	wireFixed64 = 1
	wireBytes   = 2
	wireFixed32 = 5
)

var errTruncatedProto = errors.New("dataeng: truncated protobuf message")

// protoReader is a deliberately small protobuf reader. ORC metadata uses
// proto2 messages, but only a handful of their fields are relevant here.
type protoReader struct {
	b []byte
	i int
}

func newProtoReader(b []byte) *protoReader { return &protoReader{b: b} }

func (p *protoReader) eof() bool { return p.i >= len(p.b) }

func (p *protoReader) remaining() int { return len(p.b) - p.i }

func (p *protoReader) varint() (uint64, error) {
	var x uint64
	var shift uint
	for {
		if p.i >= len(p.b) {
			return 0, errTruncatedProto
		}
		c := p.b[p.i]
		p.i++
		if shift == 63 && c > 1 {
			return 0, errors.New("dataeng: protobuf varint overflow")
		}
		x |= uint64(c&0x7f) << shift
		if c < 0x80 {
			return x, nil
		}
		shift += 7
		if shift >= 64 {
			return 0, errors.New("dataeng: protobuf varint overflow")
		}
	}
}

func (p *protoReader) svarint() (int64, error) {
	x, err := p.varint()
	if err != nil {
		return 0, err
	}
	return int64(x>>1) ^ -int64(x&1), nil
}

func (p *protoReader) tag() (field int, wire int, err error) {
	x, err := p.varint()
	if err != nil {
		return 0, 0, err
	}
	field = int(x >> 3)
	wire = int(x & 7)
	if field <= 0 {
		return 0, 0, fmt.Errorf("dataeng: invalid protobuf field number %d", field)
	}
	return field, wire, nil
}

func (p *protoReader) bytes() ([]byte, error) {
	n, err := p.varint()
	if err != nil {
		return nil, err
	}
	if n > uint64(p.remaining()) {
		return nil, errTruncatedProto
	}
	out := p.b[p.i : p.i+int(n)]
	p.i += int(n)
	return out, nil
}

func (p *protoReader) string() (string, error) {
	b, err := p.bytes()
	if err != nil {
		return "", err
	}
	return string(b), nil
}

func (p *protoReader) fixed64() (uint64, error) {
	if p.remaining() < 8 {
		return 0, errTruncatedProto
	}
	x := binary.LittleEndian.Uint64(p.b[p.i:])
	p.i += 8
	return x, nil
}

func (p *protoReader) fixed32() (uint32, error) {
	if p.remaining() < 4 {
		return 0, errTruncatedProto
	}
	x := binary.LittleEndian.Uint32(p.b[p.i:])
	p.i += 4
	return x, nil
}

func (p *protoReader) double() (float64, error) {
	x, err := p.fixed64()
	if err != nil {
		return 0, err
	}
	return math.Float64frombits(x), nil
}

func (p *protoReader) float() (float32, error) {
	x, err := p.fixed32()
	if err != nil {
		return 0, err
	}
	return math.Float32frombits(x), nil
}

func (p *protoReader) skip(wire int) error {
	switch wire {
	case wireVarint:
		_, err := p.varint()
		return err
	case wireFixed64:
		_, err := p.fixed64()
		return err
	case wireBytes:
		_, err := p.bytes()
		return err
	case wireFixed32:
		_, err := p.fixed32()
		return err
	default:
		return fmt.Errorf("dataeng: unsupported protobuf wire type %d", wire)
	}
}

func (p *protoReader) packedUvarints() ([]uint64, error) {
	b, err := p.bytes()
	if err != nil {
		return nil, err
	}
	sub := newProtoReader(b)
	var out []uint64
	for !sub.eof() {
		v, err := sub.varint()
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func appendUvarint(dst []byte, v uint64) []byte {
	var buf [10]byte
	n := binary.PutUvarint(buf[:], v)
	return append(dst, buf[:n]...)
}

func appendTag(dst []byte, field int, wire int) []byte {
	return appendUvarint(dst, uint64(field)<<3|uint64(wire))
}

func appendVarintField(dst []byte, field int, v uint64) []byte {
	dst = appendTag(dst, field, wireVarint)
	return appendUvarint(dst, v)
}

func appendSvarintField(dst []byte, field int, v int64) []byte {
	uv := uint64(v<<1) ^ uint64(v>>63)
	return appendVarintField(dst, field, uv)
}

func appendBytesField(dst []byte, field int, b []byte) []byte {
	dst = appendTag(dst, field, wireBytes)
	dst = appendUvarint(dst, uint64(len(b)))
	return append(dst, b...)
}

func appendStringField(dst []byte, field int, s string) []byte {
	return appendBytesField(dst, field, []byte(s))
}

func appendFixed64Field(dst []byte, field int, v uint64) []byte {
	dst = appendTag(dst, field, wireFixed64)
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], v)
	return append(dst, buf[:]...)
}

func appendPackedUvarints(dst []byte, field int, values []uint64) []byte {
	if len(values) == 0 {
		return dst
	}
	var body []byte
	for _, v := range values {
		body = appendUvarint(body, v)
	}
	return appendBytesField(dst, field, body)
}

func zigzag(v int64) uint64 { return uint64(v<<1) ^ uint64(v>>63) }
