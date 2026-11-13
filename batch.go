package dataeng

import (
	"encoding/binary"
	"fmt"
	"math"
)

const (
	// DefaultMaxRecordBytes is the record-length limit used by ParseBatch and NewDefaultReader.
	DefaultMaxRecordBytes = 1 << 20

	recordBatchMagic      = 2
	recordBatchHeaderSize = 57
	batchLengthAdjustment = 12
	recordLengthSize      = 4

	recordControlFlag         = 0x20
	batchCompressionCodecMask = 0x07
	batchTransactionalFlag    = 0x10
	batchControlFlag          = 0x20
	controlRecordVersion      = 0
	controlRecordTypeAbort    = 0
	controlRecordTypeCommit   = 1
	controlRecordKeySize      = 4
)

// MarkerType identifies a transaction control marker carried by a control record.
type MarkerType int8

const (
	// MarkerNone means the record is not a transaction control record.
	MarkerNone MarkerType = iota
	// MarkerCommit marks a committed transaction.
	MarkerCommit
	// MarkerAbort marks an aborted transaction.
	MarkerAbort
)

// String returns "commit", "abort", or "none".
func (m MarkerType) String() string {
	switch m {
	case MarkerCommit:
		return "commit"
	case MarkerAbort:
		return "abort"
	default:
		return "none"
	}
}

// Header is one record header. A nil value denotes a null header value.
type Header struct {
	Key   []byte
	Value []byte
}

// Record is one decoded record. Offset and Timestamp are absolute values derived
// from the batch base values and the record deltas. Key, Value, and header byte
// slices alias the input buffer passed to the reader.
//
// A control record is retained in Batch.Records just like a business record.
// Callers decide whether a control record is visible to downstream consumers.
type Record struct {
	Attributes     int8
	Offset         int64
	Timestamp      int64
	OffsetDelta    int32
	TimestampDelta int64
	Key            []byte
	Value          []byte
	Headers        []Header
	Control        bool
	Marker         MarkerType
}

// Batch is one decoded record batch.
type Batch struct {
	BaseOffset           int64
	PartitionLeaderEpoch int32
	Magic                int8
	CRC                  uint32
	Attributes           int16
	LastOffsetDelta      int32
	BaseTimestamp        int64
	MaxTimestamp         int64
	ProducerID           int64
	ProducerEpoch        int16
	BaseSequence         int32
	Records              []Record
	Size                 int
}

// LastOffset returns baseOffset + lastOffsetDelta, the offset of the batch's
// last record as declared by the batch header.
func (b *Batch) LastOffset() int64 {
	return b.BaseOffset + int64(b.LastOffsetDelta)
}

// Transactional reports whether the batch carries the transactional attribute.
func (b *Batch) Transactional() bool {
	return b.Attributes&batchTransactionalFlag != 0
}

// IsControl reports whether the batch carries the control-batch attribute.
func (b *Batch) IsControl() bool {
	return b.Attributes&batchControlFlag != 0
}

// Reader decodes record batches from caller-supplied bytes. It never connects
// to a cluster. The zero value uses DefaultMaxRecordBytes.
type Reader struct {
	maxRecordBytes int
}

// NewReader returns a Reader that rejects records whose declared length is
// greater than maxRecordBytes. The limit is checked as soon as the four-byte
// record length is readable, before the record body is consumed or allocated.
func NewReader(maxRecordBytes int) (*Reader, error) {
	if maxRecordBytes <= 0 {
		return nil, fmt.Errorf("dataeng: max record bytes must be positive, got %d", maxRecordBytes)
	}
	return &Reader{maxRecordBytes: maxRecordBytes}, nil
}

// NewDefaultReader returns a Reader with DefaultMaxRecordBytes.
func NewDefaultReader() *Reader {
	return &Reader{maxRecordBytes: DefaultMaxRecordBytes}
}

// MaxRecordBytes returns the configured per-record length limit.
func (r *Reader) MaxRecordBytes() int {
	return r.limit()
}

func (r *Reader) limit() int {
	if r == nil || r.maxRecordBytes <= 0 {
		return DefaultMaxRecordBytes
	}
	return r.maxRecordBytes
}

// ReadBatch decodes exactly one batch and rejects trailing bytes.
func (r *Reader) ReadBatch(data []byte) (*Batch, error) {
	batch, consumed, err := r.readBatch(data)
	if err != nil {
		return nil, err
	}
	if consumed != len(data) {
		return nil, fmt.Errorf("%w: %d trailing bytes after batch", ErrInvalidBatch, len(data)-consumed)
	}
	return batch, nil
}

// ReadBatches decodes all concatenated batches in data.
func (r *Reader) ReadBatches(data []byte) ([]*Batch, error) {
	var batches []*Batch
	for len(data) > 0 {
		batch, consumed, err := r.readBatch(data)
		if err != nil {
			return nil, err
		}
		batches = append(batches, batch)
		data = data[consumed:]
	}
	return batches, nil
}

// ParseBatch decodes exactly one batch using DefaultMaxRecordBytes.
func ParseBatch(data []byte) (*Batch, error) {
	return NewDefaultReader().ReadBatch(data)
}

// ParseBatchWithLimit decodes exactly one batch using the supplied per-record limit.
func ParseBatchWithLimit(data []byte, maxRecordBytes int) (*Batch, error) {
	reader, err := NewReader(maxRecordBytes)
	if err != nil {
		return nil, err
	}
	return reader.ReadBatch(data)
}

func (r *Reader) readBatch(data []byte) (*Batch, int, error) {
	if len(data) < batchLengthAdjustment {
		return nil, 0, fmt.Errorf("%w: batch header needs %d bytes, got %d", ErrTruncated, batchLengthAdjustment, len(data))
	}

	rawLength := int32(binary.BigEndian.Uint32(data[8:12]))
	if rawLength < recordBatchHeaderSize-batchLengthAdjustment {
		return nil, 0, fmt.Errorf("%w: batch length %d is smaller than the batch header", ErrInvalidBatch, rawLength)
	}
	total64 := int64(batchLengthAdjustment) + int64(rawLength)
	if total64 > int64(len(data)) {
		return nil, 0, fmt.Errorf("%w: batch needs %d bytes, got %d", ErrTruncated, total64, len(data))
	}
	total := int(total64)
	header := data[:total]

	magic := int8(header[16])
	if magic != recordBatchMagic {
		return nil, 0, fmt.Errorf("%w: got magic %d, want %d", ErrUnsupportedMagic, magic, recordBatchMagic)
	}
	attributes := int16(binary.BigEndian.Uint16(header[21:23]))
	if codec := attributes & batchCompressionCodecMask; codec != 0 {
		return nil, 0, fmt.Errorf("%w: codec %d", ErrUnsupportedCompression, codec)
	}

	baseOffset := int64(binary.BigEndian.Uint64(header[0:8]))
	lastOffsetDelta := int32(binary.BigEndian.Uint32(header[23:27]))
	baseTimestamp := int64(binary.BigEndian.Uint64(header[27:35]))
	maxTimestamp := int64(binary.BigEndian.Uint64(header[35:43]))

	records, err := r.parseRecords(header[recordBatchHeaderSize:], baseOffset, baseTimestamp, maxTimestamp)
	if err != nil {
		return nil, 0, err
	}
	if len(records) == 0 {
		if lastOffsetDelta < -1 {
			return nil, 0, fmt.Errorf("%w: empty batch has last offset delta %d", ErrLastOffsetMismatch, lastOffsetDelta)
		}
	} else {
		if lastOffsetDelta < 0 {
			return nil, 0, fmt.Errorf("%w: last offset delta %d is negative", ErrLastOffsetMismatch, lastOffsetDelta)
		}
		declaredLast, ok := addInt64(baseOffset, int64(lastOffsetDelta))
		if !ok || declaredLast != records[len(records)-1].Offset {
			return nil, 0, fmt.Errorf("%w: base %d + last delta %d != last record offset %d",
				ErrLastOffsetMismatch, baseOffset, lastOffsetDelta, records[len(records)-1].Offset)
		}
	}

	batch := &Batch{
		BaseOffset:           baseOffset,
		PartitionLeaderEpoch: int32(binary.BigEndian.Uint32(header[12:16])),
		Magic:                magic,
		CRC:                  binary.BigEndian.Uint32(header[17:21]),
		Attributes:           attributes,
		LastOffsetDelta:      lastOffsetDelta,
		BaseTimestamp:        baseTimestamp,
		MaxTimestamp:         maxTimestamp,
		ProducerID:           int64(binary.BigEndian.Uint64(header[43:51])),
		ProducerEpoch:        int16(binary.BigEndian.Uint16(header[51:53])),
		BaseSequence:         int32(binary.BigEndian.Uint32(header[53:57])),
		Records:              records,
		Size:                 total,
	}
	return batch, total, nil
}

func (r *Reader) parseRecords(data []byte, baseOffset, baseTimestamp, maxTimestamp int64) ([]Record, error) {
	limit := r.limit()
	var records []Record
	pos := 0
	var previousOffset int64
	havePrevious := false

	for pos < len(data) {
		if len(data)-pos < recordLengthSize {
			return nil, fmt.Errorf("%w: record length at byte %d", ErrTruncated, pos)
		}
		length := int32(binary.BigEndian.Uint32(data[pos : pos+recordLengthSize]))
		recordStart := pos
		pos += recordLengthSize

		if length < 0 {
			return nil, fmt.Errorf("%w: negative record length %d at byte %d", ErrInvalidRecord, length, recordStart)
		}
		if int64(length) > int64(limit) {
			return nil, fmt.Errorf("%w: record length %d at byte %d exceeds limit %d",
				ErrRecordTooLarge, length, recordStart, limit)
		}
		if int64(length) > int64(len(data)-pos) {
			return nil, fmt.Errorf("%w: record at byte %d declares %d bytes, %d remain",
				ErrTruncated, recordStart, length, len(data)-pos)
		}

		end := pos + int(length)
		record, err := decodeRecord(data[pos:end], baseOffset, baseTimestamp, maxTimestamp)
		if err != nil {
			return nil, err
		}
		if havePrevious && record.Offset <= previousOffset {
			return nil, fmt.Errorf("%w: offset %d follows %d", ErrRecordOrder, record.Offset, previousOffset)
		}
		previousOffset = record.Offset
		havePrevious = true
		records = append(records, record)
		pos = end
	}

	return records, nil
}

func decodeRecord(body []byte, baseOffset, baseTimestamp, maxTimestamp int64) (Record, error) {
	if len(body) == 0 {
		return Record{}, fmt.Errorf("%w: empty record body", ErrInvalidRecord)
	}

	attributes := int8(body[0])
	pos := 1

	timestampDelta, n, err := readVarlong(body, pos)
	if err != nil {
		return Record{}, err
	}
	pos += n

	offsetDelta, n, err := readVarint(body, pos)
	if err != nil {
		return Record{}, err
	}
	pos += n

	key, n, err := readNullableBytes(body, pos)
	if err != nil {
		return Record{}, err
	}
	pos += n

	value, n, err := readNullableBytes(body, pos)
	if err != nil {
		return Record{}, err
	}
	pos += n

	headers, n, err := readHeaders(body, pos)
	if err != nil {
		return Record{}, err
	}
	pos += n

	if pos != len(body) {
		return Record{}, fmt.Errorf("%w: %d trailing bytes inside record", ErrInvalidRecord, len(body)-pos)
	}
	if offsetDelta < 0 {
		return Record{}, fmt.Errorf("%w: offset delta %d", ErrInvalidOffsetDelta, offsetDelta)
	}

	offset, ok := addInt64(baseOffset, int64(offsetDelta))
	if !ok {
		return Record{}, fmt.Errorf("%w: base offset %d + delta %d overflows", ErrInvalidOffsetDelta, baseOffset, offsetDelta)
	}
	timestamp, ok := addInt64(baseTimestamp, timestampDelta)
	if !ok {
		return Record{}, fmt.Errorf("%w: base timestamp %d + delta %d overflows", ErrInvalidTimestamp, baseTimestamp, timestampDelta)
	}
	if timestamp > maxTimestamp {
		return Record{}, fmt.Errorf("%w: timestamp %d > max %d (delta %d)",
			ErrTimestampAfterMax, timestamp, maxTimestamp, timestampDelta)
	}

	record := Record{
		Attributes:     attributes,
		Offset:         offset,
		Timestamp:      timestamp,
		OffsetDelta:    offsetDelta,
		TimestampDelta: timestampDelta,
		Key:            key,
		Value:          value,
		Headers:        headers,
	}

	if attributes&recordControlFlag != 0 {
		marker, err := decodeMarker(key)
		if err != nil {
			return Record{}, err
		}
		record.Control = true
		record.Marker = marker
	}

	return record, nil
}

func readNullableBytes(data []byte, pos int) ([]byte, int, error) {
	length, n, err := readVarint(data, pos)
	if err != nil {
		return nil, 0, err
	}
	if length < -1 {
		return nil, 0, fmt.Errorf("%w: negative byte length %d", ErrInvalidRecord, length)
	}
	pos += n
	if length == -1 {
		return nil, n, nil
	}
	if int64(length) > int64(len(data)-pos) {
		return nil, 0, fmt.Errorf("%w: field at byte %d declares %d bytes, %d remain",
			ErrTruncated, pos, length, len(data)-pos)
	}
	value := data[pos : pos+int(length)]
	return value, n + int(length), nil
}

func readHeaders(data []byte, pos int) ([]Header, int, error) {
	start := pos
	count, n, err := readVarint(data, pos)
	if err != nil {
		return nil, 0, err
	}
	if count < 0 {
		return nil, 0, fmt.Errorf("%w: negative header count %d", ErrInvalidRecord, count)
	}
	pos += n
	if int64(count) > int64(len(data)-pos)/2 {
		return nil, 0, fmt.Errorf("%w: %d headers cannot fit in %d remaining bytes",
			ErrTruncated, count, len(data)-pos)
	}

	var headers []Header
	for i := int32(0); i < count; i++ {
		key, keyBytes, err := readNullableBytes(data, pos)
		if err != nil {
			return nil, 0, err
		}
		if key == nil {
			return nil, 0, fmt.Errorf("%w: header %d has a null key", ErrInvalidRecord, i)
		}
		pos += keyBytes

		value, valueBytes, err := readNullableBytes(data, pos)
		if err != nil {
			return nil, 0, err
		}
		pos += valueBytes
		headers = append(headers, Header{Key: key, Value: value})
	}
	return headers, pos - start, nil
}

func decodeMarker(key []byte) (MarkerType, error) {
	if len(key) < controlRecordKeySize {
		return MarkerNone, fmt.Errorf("%w: key length %d", ErrInvalidControlRecord, len(key))
	}
	version := binary.BigEndian.Uint16(key[0:2])
	if version != controlRecordVersion {
		return MarkerNone, fmt.Errorf("%w: version %d", ErrInvalidControlRecord, version)
	}
	kind := int16(binary.BigEndian.Uint16(key[2:4]))
	switch kind {
	case controlRecordTypeCommit:
		return MarkerCommit, nil
	case controlRecordTypeAbort:
		return MarkerAbort, nil
	default:
		return MarkerNone, fmt.Errorf("%w: %d", ErrUnknownTransactionMarker, kind)
	}
}

func addInt64(a, b int64) (int64, bool) {
	if b > 0 && a > math.MaxInt64-b {
		return 0, false
	}
	if b < 0 && a < math.MinInt64-b {
		return 0, false
	}
	return a + b, true
}
