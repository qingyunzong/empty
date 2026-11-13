package dataeng_test

import "encoding/binary"

const (
	wireBatchHeaderSize   = 57
	wireBatchLengthOffset = 12
)

type wireHeader struct {
	key       []byte
	value     []byte
	nullValue bool
}

type wireRecord struct {
	offsetDelta    int32
	timestampDelta int64
	key            []byte
	nullKey        bool
	value          []byte
	nullValue      bool
	headers        []wireHeader
	control        bool
	marker         int16
	rawBody        []byte
	declaredLength int32
	overrideLength bool
}

type wireBatch struct {
	baseOffset           int64
	partitionLeaderEpoch int32
	magic                int8
	crc                  uint32
	attributes           int16
	lastOffsetDelta      int32
	baseTimestamp        int64
	maxTimestamp         int64
	producerID           int64
	producerEpoch        int16
	baseSequence         int32
	records              []wireRecord
	rawRecords           []byte
	overrideBatchLength  bool
	batchLength          int32
}

func newWireBatch(baseOffset, baseTimestamp, maxTimestamp int64, lastOffsetDelta int32, records ...wireRecord) wireBatch {
	return wireBatch{
		baseOffset:      baseOffset,
		magic:           2,
		lastOffsetDelta: lastOffsetDelta,
		baseTimestamp:   baseTimestamp,
		maxTimestamp:    maxTimestamp,
		records:         records,
	}
}

func encodeBatch(batch wireBatch) []byte {
	records := batch.rawRecords
	if records == nil {
		for _, record := range batch.records {
			records = append(records, encodeRecord(record)...)
		}
	}

	length := int32(wireBatchHeaderSize + len(records) - wireBatchLengthOffset)
	if batch.overrideBatchLength {
		length = batch.batchLength
	}

	out := make([]byte, wireBatchHeaderSize)
	binary.BigEndian.PutUint64(out[0:8], uint64(batch.baseOffset))
	binary.BigEndian.PutUint32(out[8:12], uint32(length))
	binary.BigEndian.PutUint32(out[12:16], uint32(batch.partitionLeaderEpoch))
	out[16] = byte(batch.magic)
	binary.BigEndian.PutUint32(out[17:21], batch.crc)
	binary.BigEndian.PutUint16(out[21:23], uint16(batch.attributes))
	binary.BigEndian.PutUint32(out[23:27], uint32(batch.lastOffsetDelta))
	binary.BigEndian.PutUint64(out[27:35], uint64(batch.baseTimestamp))
	binary.BigEndian.PutUint64(out[35:43], uint64(batch.maxTimestamp))
	binary.BigEndian.PutUint64(out[43:51], uint64(batch.producerID))
	binary.BigEndian.PutUint16(out[51:53], uint16(batch.producerEpoch))
	binary.BigEndian.PutUint32(out[53:57], uint32(batch.baseSequence))
	return append(out, records...)
}

func encodeRecord(record wireRecord) []byte {
	var body []byte
	if record.rawBody != nil {
		body = append(body, record.rawBody...)
	} else {
		attributes := byte(0)
		if record.control {
			attributes = 0x20
		}
		body = append(body, attributes)
		body = append(body, encodeVarlong(record.timestampDelta)...)
		body = append(body, encodeVarint(record.offsetDelta)...)

		if record.control {
			key := make([]byte, 4)
			binary.BigEndian.PutUint16(key[0:2], 0)
			binary.BigEndian.PutUint16(key[2:4], uint16(record.marker))
			body = append(body, encodeVarint(int32(len(key)))...)
			body = append(body, key...)
		} else {
			body = appendWireBytes(body, record.key, record.nullKey)
		}
		body = appendWireBytes(body, record.value, record.nullValue)

		body = append(body, encodeVarint(int32(len(record.headers)))...)
		for _, header := range record.headers {
			body = append(body, encodeVarint(int32(len(header.key)))...)
			body = append(body, header.key...)
			body = appendWireBytes(body, header.value, header.nullValue)
		}
	}

	length := int32(len(body))
	if record.overrideLength {
		length = record.declaredLength
	}
	prefix := make([]byte, 4)
	binary.BigEndian.PutUint32(prefix, uint32(length))
	return append(prefix, body...)
}

func appendWireBytes(dst []byte, value []byte, isNull bool) []byte {
	if isNull {
		return append(dst, encodeVarint(-1)...)
	}
	dst = append(dst, encodeVarint(int32(len(value)))...)
	return append(dst, value...)
}

func encodeVarint(value int32) []byte {
	raw := uint32((value << 1) ^ (value >> 31))
	var out []byte
	for raw >= 0x80 {
		out = append(out, byte(raw&0x7f)|0x80)
		raw >>= 7
	}
	return append(out, byte(raw))
}

func encodeVarlong(value int64) []byte {
	raw := uint64(value<<1) ^ uint64(value>>63)
	var out []byte
	for raw >= 0x80 {
		out = append(out, byte(raw&0x7f)|0x80)
		raw >>= 7
	}
	return append(out, byte(raw))
}
