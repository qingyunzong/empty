// Package mat5enc is a standalone encoder fixture for the closed MAT-Level-5
// subset consumed by package mat5. It deliberately shares no internal types
// with the parser, so tests exercise the on-disk format through public bytes.
//
// No MATLAB installation or external matrix library is required.
package mat5enc

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
)

// Endian selects the fixed serialization byte order.
type Endian int

const (
	LittleEndian Endian = iota
	BigEndian
)

// Element type tags.
const (
	TypeInt8    uint32 = 1
	TypeInt32   uint32 = 5
	TypeUInt32  uint32 = 6
	TypeFloat64 uint32 = 9
	TypeMatrix  uint32 = 14
	TypeZlib    uint32 = 15
)

// Matrix describes one matrix to encode. Children is used only for cell
// matrices and are taken in column-major order.
type Matrix struct {
	Name        string
	Class       uint32 // 1 cell, 6 double, 12 int32
	Complex     bool
	Dims        []int32
	Real        []uint64 // raw double bit patterns for class 6
	Imag        []uint64 // raw double bit patterns for class 6 complex
	Int32       []int32  // values for class 12
	Children    []*Matrix
	isCellChild bool
}

// Builder accumulates encoded top-level elements.
type Builder struct {
	order binary.ByteOrder
	bo    Endian
	buf   bytes.Buffer
}

// NewBuilder returns an empty builder using the given byte order.
func NewBuilder(bo Endian) *Builder {
	b := &Builder{bo: bo}
	if bo == BigEndian {
		b.order = binary.BigEndian
	} else {
		b.order = binary.LittleEndian
	}
	return b
}

// Bytes returns the bytes accumulated so far.
func (b *Builder) Bytes() []byte { return b.buf.Bytes() }

// AddMatrix appends a padded normal matrix element.
func (b *Builder) AddMatrix(m *Matrix) error {
	raw, err := b.matrixBytes(m)
	if err != nil {
		return err
	}
	b.writeNormal(TypeMatrix, raw)
	return nil
}

// MatrixElement returns the complete on-disk bytes of one padded matrix
// element without appending them to the builder.
func (b *Builder) MatrixElement(m *Matrix) ([]byte, error) {
	raw, err := b.matrixBytes(m)
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	tmp := make([]byte, 8)
	b.order.PutUint32(tmp[0:4], TypeMatrix)
	b.order.PutUint32(tmp[4:8], uint32(len(raw)))
	out.Write(tmp)
	out.Write(raw)
	if pad := (8 - (len(raw) % 8)) % 8; pad > 0 {
		out.Write(make([]byte, pad))
	}
	return out.Bytes(), nil
}

// AddCompressed compresses one matrix and appends a type-15 element WITHOUT
// trailing padding, allowing another variable to start on any offset.
func (b *Builder) AddCompressed(m *Matrix) error {
	raw, err := b.MatrixElement(m)
	if err != nil {
		return err
	}
	var zb bytes.Buffer
	w := zlib.NewWriter(&zb)
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if err := w.Close(); err != nil {
		return err
	}
	compressed := zb.Bytes()
	if uint64(len(compressed)) > uint64(^uint32(0)) {
		return fmt.Errorf("mat5enc: compressed payload too large")
	}
	b.writeUint32(TypeZlib)
	b.writeUint32(uint32(len(compressed)))
	b.buf.Write(compressed) // no 8-byte padding by specification
	return nil
}

// AddRaw appends caller-crafted bytes, useful for negative fixtures.
func (b *Builder) AddRaw(p []byte) {
	b.buf.Write(p)
}

func complexBit(complex bool) uint32 {
	if complex {
		return 0x800
	}
	return 0
}

func (b *Builder) writeUint32(v uint32) {
	var tmp [4]byte
	b.order.PutUint32(tmp[:], v)
	b.buf.Write(tmp[:])
}

// writeNormal emits an 8-byte header, payload and zero padding to a multiple of
// eight bytes.
func (b *Builder) writeNormal(typ uint32, payload []byte) {
	b.writeUint32(typ)
	b.writeUint32(uint32(len(payload)))
	b.buf.Write(payload)
	if pad := (8 - (len(payload) % 8)) % 8; pad > 0 {
		b.buf.Write(make([]byte, pad))
	}
}

// writeSmall emits a compact eight-byte element: uint16 type, uint16 n then
// n data bytes padded with zeros inside the trailing four bytes.
func (b *Builder) writeSmall(typ uint32, data []byte) {
	if len(data) < 1 || len(data) > 4 {
		panic("mat5enc: small element payload must be 1..4 bytes")
	}
	var first uint32
	if b.bo == LittleEndian {
		first = uint32(uint16(typ)) | uint32(uint16(len(data)))<<16
	} else {
		first = uint32(uint16(len(data))) | uint32(uint16(typ))<<16
	}
	b.writeUint32(first)
	var tail [4]byte
	copy(tail[:], data)
	b.buf.Write(tail[:])
}

// RawHeader writes an arbitrary normal header for negative tests.
func (b *Builder) RawHeader(typ, payloadBytes uint32) {
	b.writeUint32(typ)
	b.writeUint32(payloadBytes)
}

// RawSmall writes an arbitrary compact tag plus four data bytes.
func (b *Builder) RawSmall(typeWord, sizeWord uint16, data [4]byte) {
	var first uint32
	if b.bo == LittleEndian {
		first = uint32(typeWord) | uint32(sizeWord)<<16
	} else {
		first = uint32(sizeWord) | uint32(typeWord)<<16
	}
	b.writeUint32(first)
	b.buf.Write(data[:])
}
