package dataeng

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// protobuf wire type 常量。
const (
	wireVarint  = 0
	wireFixed64 = 1
	wireBytes   = 2
	wireFixed32 = 5
)

// MVT Tile / Layer / Feature / Value 的字段号。
const (
	fieldTileLayers = 3

	fieldLayerVersion  = 15
	fieldLayerName     = 1
	fieldLayerFeatures = 2
	fieldLayerKeys     = 3
	fieldLayerValues   = 4
	fieldLayerExtent   = 5

	fieldFeatureID       = 1
	fieldFeatureTags     = 2
	fieldFeatureType     = 3
	fieldFeatureGeometry = 4

	fieldValueString = 1
	fieldValueFloat  = 2
	fieldValueDouble = 3
	fieldValueInt    = 4
	fieldValueUint   = 5
	fieldValueSint   = 6
	fieldValueBool   = 7
)

// protoWriter 是极简 protobuf 编码缓冲。
type protoWriter struct {
	buf []byte
}

func (w *protoWriter) tag(field, wireType int) {
	w.varint(uint64(field<<3 | wireType))
}

func (w *protoWriter) varint(v uint64) {
	var tmp [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(tmp[:], v)
	w.buf = append(w.buf, tmp[:n]...)
}

func (w *protoWriter) bytes(field int, payload []byte) {
	w.tag(field, wireBytes)
	w.varint(uint64(len(payload)))
	w.buf = append(w.buf, payload...)
}

func (w *protoWriter) string_(field int, s string) {
	w.tag(field, wireBytes)
	w.varint(uint64(len(s)))
	w.buf = append(w.buf, s...)
}

func (w *protoWriter) uint32Varint(field int, v uint32) {
	w.tag(field, wireVarint)
	w.varint(uint64(v))
}

func (w *protoWriter) uint64Varint(field int, v uint64) {
	w.tag(field, wireVarint)
	w.varint(v)
}

func (w *protoWriter) int64Varint(field int, v int64) {
	w.tag(field, wireVarint)
	w.varint(uint64(v))
}

func (w *protoWriter) boolVarint(field int, v bool) {
	w.tag(field, wireVarint)
	if v {
		w.varint(1)
	} else {
		w.varint(0)
	}
}

func (w *protoWriter) fixed64(field int, v uint64) {
	w.tag(field, wireFixed64)
	var tmp [8]byte
	binary.LittleEndian.PutUint64(tmp[:], v)
	w.buf = append(w.buf, tmp[:]...)
}

func (w *protoWriter) fixed32(field int, v uint32) {
	w.tag(field, wireFixed32)
	var tmp [4]byte
	binary.LittleEndian.PutUint32(tmp[:], v)
	w.buf = append(w.buf, tmp[:]...)
}

func (w *protoWriter) packedUint32(field int, values []uint32) {
	if len(values) == 0 {
		return
	}
	payload := make([]byte, 0, len(values)*2)
	for _, v := range values {
		var tmp [binary.MaxVarintLen32]byte
		n := binary.PutUvarint(tmp[:], uint64(v))
		payload = append(payload, tmp[:n]...)
	}
	w.bytes(field, payload)
}

// protoReader 是极简 protobuf 解码游标。
type protoReader struct {
	buf []byte
	pos int
}

func (r *protoReader) eof() bool { return r.pos >= len(r.buf) }

func (r *protoReader) readTag() (field, wireType int, err error) {
	v, err := r.readVarint()
	if err != nil {
		return 0, 0, err
	}
	return int(v >> 3), int(v & 0x7), nil
}

func (r *protoReader) readVarint() (uint64, error) {
	v, n := binary.Uvarint(r.buf[r.pos:])
	if n <= 0 {
		return 0, errors.New("dataeng: malformed varint")
	}
	r.pos += n
	return v, nil
}

func (r *protoReader) readFixed64() (uint64, error) {
	if r.pos+8 > len(r.buf) {
		return 0, errors.New("dataeng: truncated fixed64")
	}
	v := binary.LittleEndian.Uint64(r.buf[r.pos:])
	r.pos += 8
	return v, nil
}

func (r *protoReader) readFixed32() (uint32, error) {
	if r.pos+4 > len(r.buf) {
		return 0, errors.New("dataeng: truncated fixed32")
	}
	v := binary.LittleEndian.Uint32(r.buf[r.pos:])
	r.pos += 4
	return v, nil
}

func (r *protoReader) readBytes() ([]byte, error) {
	length, err := r.readVarint()
	if err != nil {
		return nil, err
	}
	if length > uint64(len(r.buf)-r.pos) {
		return nil, errors.New("dataeng: length-delimited field out of range")
	}
	out := r.buf[r.pos : r.pos+int(length)]
	r.pos += int(length)
	return out, nil
}

func (r *protoReader) skipField(wireType int) error {
	switch wireType {
	case wireVarint:
		_, err := r.readVarint()
		return err
	case wireFixed64:
		_, err := r.readFixed64()
		return err
	case wireFixed32:
		_, err := r.readFixed32()
		return err
	case wireBytes:
		_, err := r.readBytes()
		return err
	default:
		return fmt.Errorf("dataeng: unsupported wire type %d", wireType)
	}
}
