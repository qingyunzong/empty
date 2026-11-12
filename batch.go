// Package dataeng provides a streaming parser and validator for the
// uncompressed Kafka-style record batches described in README.md.
package dataeng

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
)

// Config contains the host limits applied while parsing.
//
// MaxBatchBytes bounds the complete batch, including its 12-byte prefix. It
// must be large enough for an empty batch (61 bytes). MaxRecords bounds the
// number of records in one batch.
type Config struct {
	MaxBatchBytes int
	MaxRecords    int
}

// Limits is an alias for Config.
type Limits = Config

// Options is an alias for Config.
type Options = Config

// TimestampType identifies which timestamp representation a batch uses.
type TimestampType uint8

const (
	// CreateTime means each record stores a timestamp delta from BaseTimestamp.
	CreateTime TimestampType = 0
	// AppendTime means records use MaxTimestamp and must carry a zero delta.
	AppendTime TimestampType = 1
)

// ControlType is the type encoded in the last two bytes of a control
// record's key.
type ControlType uint16

const (
	// ControlAbort aborts a transaction.
	ControlAbort ControlType = 0
	// ControlCommit commits a transaction.
	ControlCommit ControlType = 1
)

// Header is one raw record header. Duplicate header keys are preserved in
// input order. A nil Value denotes the wire value -1; a non-nil empty slice
// denotes a present zero-length value.
type Header struct {
	Key   []byte
	Value []byte
}

// Record is a fully validated record in a batch.
//
// Key and Value are snapshots of the wire bytes. A nil slice means the wire
// length was -1. Headers and their key/value slices are snapshots as well.
// ControlType is non-nil only for records in a control batch, in which case
// its value is ControlAbort or ControlCommit.
type Record struct {
	Offset         int64
	Timestamp      int64
	TimestampDelta int64
	OffsetDelta    int32
	Sequence       uint32
	HasSequence    bool
	Key            []byte
	Value          []byte
	Headers        []Header
	ControlType    *ControlType
}

// Batch is one validated, complete uncompressed batch.
//
// Start and End are byte offsets in the host stream and form a half-open
// interval [Start, End). The slices in Records are owned by the batch and do
// not refer to the caller's input buffers.
type Batch struct {
	BaseOffset      int64
	BatchLength     int32
	LeaderEpoch     int32
	Magic           int8
	CRC             uint32
	Attributes      uint16
	LastOffsetDelta int32
	BaseTimestamp   int64
	MaxTimestamp    int64
	ProducerID      int64
	ProducerEpoch   int16
	BaseSequence    int32
	RecordsCount    int32
	Records         []Record
	Start           int64
	End             int64
}

// Transactional reports whether attributes bit 4 is set.
func (b Batch) Transactional() bool { return b.Attributes&0x0010 != 0 }

// Control reports whether attributes bit 5 is set.
func (b Batch) Control() bool { return b.Attributes&0x0020 != 0 }

// TimestampType reports the timestamp representation selected by bit 3.
func (b Batch) TimestampType() TimestampType {
	if b.Attributes&0x0008 != 0 {
		return AppendTime
	}
	return CreateTime
}

var (
	// ErrStopped is returned after a failure or after a successful Finish.
	ErrStopped = errors.New("dataeng: parser stopped")
	// ErrTrailingData is returned by Finish when an incomplete batch remains.
	ErrTrailingData = errors.New("dataeng: unfinished batch data")
	// ErrInvalidBatch is the common category for malformed batch data.
	ErrInvalidBatch = errors.New("dataeng: invalid batch")
	// ErrBatchTooSmall is returned for a declared batchLength below 49.
	ErrBatchTooSmall = errors.New("dataeng: batchLength below 49")
	// ErrBatchTooLarge is returned when 12+batchLength exceeds the host limit.
	ErrBatchTooLarge = errors.New("dataeng: batch exceeds host limit")
	// ErrBadCRC is returned when the stored CRC does not match the content.
	ErrBadCRC = errors.New("dataeng: checksum mismatch")
	// ErrRecordCount is returned when records do not match recordsCount.
	ErrRecordCount = errors.New("dataeng: record count mismatch")
)

// Parser incrementally assembles and validates complete batches from an
// arbitrary sequence of input chunks. A Parser is not safe for concurrent use.
type Parser struct {
	maxBatchBytes int
	maxRecords    int

	pending   []byte
	base      int64
	stopped   bool
	finished  bool
	stopError error
}

// Assembler is an alias for Parser.
type Assembler = Parser

// Reassembler is an alias for Parser.
type Reassembler = Parser

// BatchParser is an alias for Parser.
type BatchParser = Parser

// NewParser constructs a Parser. It accepts either a Config/Limits/Options
// value, a *Config, or the pair (maxBatchBytes, maxRecords). With no
// arguments it uses a 1 MiB batch limit and a 1,000,000 record limit.
//
// Invalid configuration is reported by Push or Finish rather than by this
// constructor.
func NewParser(args ...any) *Parser {
	const (
		defaultMaxBytes   = 1 << 20
		defaultMaxRecords = 1_000_000
	)

	cfg := Config{MaxBatchBytes: defaultMaxBytes, MaxRecords: defaultMaxRecords}
	badConfig := false

	switch len(args) {
	case 0:
	case 1:
		switch v := args[0].(type) {
		case Config:
			cfg = v
		case *Config:
			if v == nil {
				badConfig = true
			} else {
				cfg = *v
			}
		case int:
			cfg.MaxBatchBytes = v
		case int32:
			cfg.MaxBatchBytes = int(v)
		case int64:
			cfg.MaxBatchBytes = int(v)
		default:
			badConfig = true
		}
	case 2:
		ok := true
		cfg.MaxBatchBytes, ok = integerArg(args[0])
		if ok {
			cfg.MaxRecords, ok = integerArg(args[1])
		}
		badConfig = !ok
	default:
		badConfig = true
	}

	p := &Parser{maxBatchBytes: cfg.MaxBatchBytes, maxRecords: cfg.MaxRecords}
	if badConfig || cfg.MaxBatchBytes < 0 || cfg.MaxRecords < 0 {
		p.stopped = true
		p.stopError = fmt.Errorf("%w: invalid parser configuration", ErrInvalidBatch)
	}
	return p
}

func integerArg(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int32:
		return int(n), true
	case int64:
		return int(n), true
	case uint:
		return int(n), true
	case uint32:
		return int(n), true
	case uint64:
		if n > math.MaxInt {
			return 0, false
		}
		return int(n), true
	default:
		return 0, false
	}
}

// New constructs a Parser using the same arguments as NewParser.
func New(args ...any) *Parser { return NewParser(args...) }

// NewAssembler constructs a Parser using the same arguments as NewParser.
func NewAssembler(args ...any) *Parser { return NewParser(args...) }

// NewReassembler constructs a Parser using the same arguments as NewParser.
func NewReassembler(args ...any) *Parser { return NewParser(args...) }

// NewBatchParser constructs a Parser using the same arguments as NewParser.
func NewBatchParser(args ...any) *Parser { return NewParser(args...) }

// NewParserWithConfig constructs a Parser from a Config value.
func NewParserWithConfig(cfg Config) *Parser { return NewParser(cfg) }

// Push supplies the next arbitrary byte boundary of the input stream and
// returns the batches completed by this call. A complete batch is returned
// only after its CRC, lengths, attributes, and records have all validated.
// Batches completed before a later error in the same chunk are returned with
// that error.
func (p *Parser) Push(chunk []byte) ([]Batch, error) {
	if p.stopped {
		return nil, p.stopError
	}
	if p.finished {
		return nil, ErrStopped
	}
	if len(chunk) == 0 {
		return nil, nil
	}

	var batches []Batch
	for len(chunk) > 0 || len(p.pending) >= 12 {
		// Take only the bytes needed for the next prefix or completed batch.
		// In particular, do not copy a declared body before its length has
		// passed both limits.
		if len(p.pending) < 12 {
			needed := 12 - len(p.pending)
			if needed > len(chunk) {
				p.pending = append(p.pending, chunk...)
				return batches, nil
			}
			p.pending = append(p.pending, chunk[:needed]...)
			chunk = chunk[needed:]
		}

		batchLength := int32(binary.BigEndian.Uint32(p.pending[8:12]))

		if batchLength < 49 {
			return p.fail(batches, fmt.Errorf("%w: got %d", ErrBatchTooSmall, batchLength))
		}
		total := int64(12) + int64(batchLength)
		if total > int64(p.maxBatchBytes) {
			return p.fail(batches, fmt.Errorf("%w: %d > %d", ErrBatchTooLarge, total, p.maxBatchBytes))
		}

		needed := int(total) - len(p.pending)
		if needed > len(chunk) {
			p.pending = append(p.pending, chunk...)
			return batches, nil
		}
		if p.base > math.MaxInt64-total {
			return p.fail(batches, fmt.Errorf("%w: stream offset overflow", ErrInvalidBatch))
		}
		p.pending = append(p.pending, chunk[:needed]...)
		chunk = chunk[needed:]

		b, err := parseBatch(p.pending[:int(total)], p.base, int(p.maxRecords))
		if err != nil {
			return p.fail(batches, err)
		}
		batches = append(batches, b)

		p.pending = p.pending[:0]
		p.base += total
	}

	if len(p.pending) == 0 {
		p.pending = nil
	}
	return batches, nil
}

// Finish verifies that no partial batch remains and marks a successful parser
// as finished. It returns the same stored failure forever after any failure.
// Repeated successful Finish calls are harmless.
func (p *Parser) Finish() error {
	if p.stopped {
		return p.stopError
	}
	if p.finished {
		return nil
	}
	if len(p.pending) != 0 {
		err := fmt.Errorf("%w: %d bytes", ErrTrailingData, len(p.pending))
		p.stopped = true
		p.stopError = err
		return err
	}
	p.finished = true
	return nil
}

func (p *Parser) fail(batches []Batch, err error) ([]Batch, error) {
	p.stopped = true
	p.stopError = err
	return batches, err
}

// Pending reports the number of bytes in the incomplete batch prefix.
func (p *Parser) Pending() int { return len(p.pending) }

// StreamOffset reports the byte offset of the first pending byte.
func (p *Parser) StreamOffset() int64 { return p.base }

// Err returns the sticky parser failure, if any.
func (p *Parser) Err() error { return p.stopError }

func parseBatch(data []byte, streamStart int64, maxRecords int) (Batch, error) {
	if len(data) < 61 {
		return Batch{}, fmt.Errorf("%w: short batch", ErrInvalidBatch)
	}

	baseOffset := int64(binary.BigEndian.Uint64(data[0:8]))
	batchLength := int32(binary.BigEndian.Uint32(data[8:12]))
	leaderEpoch := int32(binary.BigEndian.Uint32(data[12:16]))
	magic := int8(data[16])
	storedCRC := binary.BigEndian.Uint32(data[17:21])
	attributes := binary.BigEndian.Uint16(data[21:23])
	lastOffsetDelta := int32(binary.BigEndian.Uint32(data[23:27]))
	baseTimestamp := int64(binary.BigEndian.Uint64(data[27:35]))
	maxTimestamp := int64(binary.BigEndian.Uint64(data[35:43]))
	producerID := int64(binary.BigEndian.Uint64(data[43:51]))
	producerEpoch := int16(binary.BigEndian.Uint16(data[51:53]))
	baseSequence := int32(binary.BigEndian.Uint32(data[53:57]))
	recordsCount := int32(binary.BigEndian.Uint32(data[57:61]))

	if magic != 2 {
		return Batch{}, fmt.Errorf("%w: magic %d", ErrInvalidBatch, magic)
	}
	if batchLength < 49 || 12+int64(batchLength) != int64(len(data)) {
		return Batch{}, fmt.Errorf("%w: inconsistent length", ErrInvalidBatch)
	}
	if calculatedCRC := CRC32C(data[21:]); calculatedCRC != storedCRC {
		return Batch{}, fmt.Errorf("%w: got %08x want %08x", ErrBadCRC, calculatedCRC, storedCRC)
	}
	if attributes&0x0007 != 0 {
		return Batch{}, fmt.Errorf("%w: compression bits set", ErrInvalidBatch)
	}
	if attributes&0xffc0 != 0 {
		return Batch{}, fmt.Errorf("%w: reserved attribute bits set", ErrInvalidBatch)
	}
	if producerID < -1 {
		return Batch{}, fmt.Errorf("%w: producerId %d", ErrInvalidBatch, producerID)
	}
	if producerID == -1 {
		if producerEpoch != -1 || baseSequence != -1 {
			return Batch{}, fmt.Errorf("%w: unsequenced producer metadata", ErrInvalidBatch)
		}
		if attributes&0x0010 != 0 {
			return Batch{}, fmt.Errorf("%w: transactional bit without producer", ErrInvalidBatch)
		}
	} else {
		if producerEpoch < 0 || producerEpoch > math.MaxInt16 || baseSequence < 0 {
			return Batch{}, fmt.Errorf("%w: invalid producer sequence metadata", ErrInvalidBatch)
		}
	}
	if recordsCount < 0 || int64(recordsCount) > int64(maxRecords) {
		return Batch{}, fmt.Errorf("%w: recordsCount %d over limit %d", ErrRecordCount, recordsCount, maxRecords)
	}

	payload := data[61:]
	records := make([]Record, 0)
	cursor := 0
	control := attributes&0x0020 != 0
	appendTime := attributes&0x0008 != 0
	hasSequence := producerID >= 0
	previousDelta := int64(-1)
	var maxSeenTimestamp int64

	for cursor < len(payload) {
		if len(records) >= int(recordsCount) {
			return Batch{}, fmt.Errorf("%w: more records than recordsCount", ErrRecordCount)
		}

		bodyLength, n, err := decodeSignedVarint32(payload[cursor:])
		if err != nil {
			return Batch{}, fmt.Errorf("record length: %w", err)
		}
		if bodyLength < 0 {
			return Batch{}, fmt.Errorf("%w: negative record length %d", ErrInvalidBatch, bodyLength)
		}
		cursor += n
		end := cursor + int(bodyLength)
		if end < cursor || end > len(payload) {
			return Batch{}, fmt.Errorf("%w: record body exceeds batch", ErrInvalidBatch)
		}

		rec, timestampDelta, offsetDelta, headersCount, err := parseRecord(payload[cursor:end], baseOffset)
		if err != nil {
			return Batch{}, err
		}
		if offsetDelta < 0 || int64(offsetDelta) <= previousDelta {
			return Batch{}, fmt.Errorf("%w: non-increasing offset delta %d", ErrInvalidBatch, offsetDelta)
		}
		previousDelta = int64(offsetDelta)

		if appendTime {
			if timestampDelta != 0 {
				return Batch{}, fmt.Errorf("%w: append-time delta %d", ErrInvalidBatch, timestampDelta)
			}
			rec.Timestamp = maxTimestamp
			if len(records) == 0 {
				maxSeenTimestamp = rec.Timestamp
			}
		} else {
			absolute, ok := addInt64(baseTimestamp, timestampDelta)
			if !ok {
				return Batch{}, fmt.Errorf("%w: timestamp overflow", ErrInvalidBatch)
			}
			rec.Timestamp = absolute
			if len(records) == 0 || absolute > maxSeenTimestamp {
				maxSeenTimestamp = absolute
			}
		}
		rec.HasSequence = hasSequence
		if hasSequence {
			rec.Sequence = uint32(uint64(uint32(baseSequence)) + uint64(len(records)))
		}
		if control {
			if len(rec.Key) != 4 {
				return Batch{}, fmt.Errorf("%w: control key length %d", ErrInvalidBatch, len(rec.Key))
			}
			if binary.BigEndian.Uint16(rec.Key[0:2]) != 0 {
				return Batch{}, fmt.Errorf("%w: control key version", ErrInvalidBatch)
			}
			if rec.Value != nil {
				return Batch{}, fmt.Errorf("%w: control record has a value", ErrInvalidBatch)
			}
			if headersCount != 0 {
				return Batch{}, fmt.Errorf("%w: control record has headers", ErrInvalidBatch)
			}
			kind := ControlType(binary.BigEndian.Uint16(rec.Key[2:4]))
			if kind != ControlAbort && kind != ControlCommit {
				return Batch{}, fmt.Errorf("%w: control type %d", ErrInvalidBatch, kind)
			}
			controlType := kind
			rec.ControlType = &controlType
		}

		records = append(records, rec)
		cursor = end
	}

	if len(records) != int(recordsCount) {
		return Batch{}, fmt.Errorf("%w: got %d want %d", ErrRecordCount, len(records), recordsCount)
	}
	if len(records) == 0 {
		if recordsCount != 0 || lastOffsetDelta != 0 || batchLength != 49 {
			return Batch{}, fmt.Errorf("%w: invalid empty batch header", ErrInvalidBatch)
		}
		if maxTimestamp != baseTimestamp {
			return Batch{}, fmt.Errorf("%w: empty batch maxTimestamp", ErrInvalidBatch)
		}
	} else {
		if int64(lastOffsetDelta) != previousDelta {
			return Batch{}, fmt.Errorf("%w: lastOffsetDelta %d != %d", ErrInvalidBatch, lastOffsetDelta, previousDelta)
		}
		if appendTime {
			if maxSeenTimestamp != maxTimestamp {
				return Batch{}, fmt.Errorf("%w: append-time maxTimestamp", ErrInvalidBatch)
			}
		} else if maxSeenTimestamp != maxTimestamp {
			return Batch{}, fmt.Errorf("%w: maxTimestamp %d != %d", ErrInvalidBatch, maxTimestamp, maxSeenTimestamp)
		}
	}

	return Batch{
		BaseOffset:      baseOffset,
		BatchLength:     batchLength,
		LeaderEpoch:     leaderEpoch,
		Magic:           magic,
		CRC:             storedCRC,
		Attributes:      attributes,
		LastOffsetDelta: lastOffsetDelta,
		BaseTimestamp:   baseTimestamp,
		MaxTimestamp:    maxTimestamp,
		ProducerID:      producerID,
		ProducerEpoch:   producerEpoch,
		BaseSequence:    baseSequence,
		RecordsCount:    recordsCount,
		Records:         records,
		Start:           streamStart,
		End:             streamStart + int64(len(data)),
	}, nil
}

func parseRecord(body []byte, baseOffset int64) (Record, int64, int32, int32, error) {
	if len(body) == 0 {
		return Record{}, 0, 0, 0, fmt.Errorf("%w: empty record body", ErrInvalidBatch)
	}
	if body[0] != 0 {
		return Record{}, 0, 0, 0, fmt.Errorf("%w: record attributes %d", ErrInvalidBatch, body[0])
	}
	pos := 1

	timestampDelta, n, err := decodeSignedVarint64(body[pos:])
	if err != nil {
		return Record{}, 0, 0, 0, fmt.Errorf("record timestamp delta: %w", err)
	}
	pos += n
	offsetDelta, n, err := decodeSignedVarint32(body[pos:])
	if err != nil {
		return Record{}, 0, 0, 0, fmt.Errorf("record offset delta: %w", err)
	}
	pos += n

	key, n, err := decodeNullableBytes(body[pos:])
	if err != nil {
		return Record{}, 0, 0, 0, fmt.Errorf("record key: %w", err)
	}
	pos += n
	value, n, err := decodeNullableBytes(body[pos:])
	if err != nil {
		return Record{}, 0, 0, 0, fmt.Errorf("record value: %w", err)
	}
	pos += n

	headersCount, n, err := decodeSignedVarint32(body[pos:])
	if err != nil {
		return Record{}, 0, 0, 0, fmt.Errorf("header count: %w", err)
	}
	pos += n
	if headersCount < 0 {
		return Record{}, 0, 0, 0, fmt.Errorf("%w: negative header count", ErrInvalidBatch)
	}

	headers := make([]Header, 0)
	for i := int32(0); i < headersCount; i++ {
		keyLength, hn, err := decodeSignedVarint32(body[pos:])
		if err != nil {
			return Record{}, 0, 0, 0, fmt.Errorf("header %d key length: %w", i, err)
		}
		pos += hn
		if keyLength < 1 {
			return Record{}, 0, 0, 0, fmt.Errorf("%w: header key length %d", ErrInvalidBatch, keyLength)
		}
		if int(keyLength) > len(body)-pos {
			return Record{}, 0, 0, 0, fmt.Errorf("%w: header key exceeds record", ErrInvalidBatch)
		}
		headerKey := clonePresent(body[pos : pos+int(keyLength)])
		pos += int(keyLength)

		headerValue, vn, err := decodeNullableBytes(body[pos:])
		if err != nil {
			return Record{}, 0, 0, 0, fmt.Errorf("header %d value: %w", i, err)
		}
		pos += vn
		headers = append(headers, Header{Key: headerKey, Value: headerValue})
	}

	if pos != len(body) {
		return Record{}, 0, 0, 0, fmt.Errorf("%w: record trailing bytes", ErrInvalidBatch)
	}

	absoluteOffset, ok := addInt64(baseOffset, int64(offsetDelta))
	if !ok {
		return Record{}, 0, 0, 0, fmt.Errorf("%w: absolute offset overflow", ErrInvalidBatch)
	}

	return Record{
		Offset:         absoluteOffset,
		TimestampDelta: timestampDelta,
		OffsetDelta:    offsetDelta,
		Key:            key,
		Value:          value,
		Headers:        headers,
	}, timestampDelta, offsetDelta, headersCount, nil
}

// decodeNullableBytes decodes a 32-bit signed length followed by that many
// bytes. Length -1 means a missing value.
func decodeNullableBytes(data []byte) ([]byte, int, error) {
	length, n, err := decodeSignedVarint32(data)
	if err != nil {
		return nil, 0, err
	}
	if length < -1 {
		return nil, 0, fmt.Errorf("%w: nullable length %d", ErrInvalidBatch, length)
	}
	if length == -1 {
		return nil, n, nil
	}
	if int(length) > len(data)-n {
		return nil, 0, fmt.Errorf("%w: byte field exceeds containing data", ErrInvalidBatch)
	}
	return clonePresent(data[n : n+int(length)]), n + int(length), nil
}

func clonePresent(data []byte) []byte {
	if len(data) == 0 {
		return []byte{}
	}
	out := make([]byte, len(data))
	copy(out, data)
	return out
}

func decodeSignedVarint32(data []byte) (int32, int, error) {
	u, n, err := decodeUnsignedVarint(data, 32)
	if err != nil {
		return 0, 0, err
	}
	v := int32(u>>1) ^ -int32(u&1)
	return v, n, nil
}

func decodeSignedVarint64(data []byte) (int64, int, error) {
	u, n, err := decodeUnsignedVarint(data, 64)
	if err != nil {
		return 0, 0, err
	}
	v := int64(u>>1) ^ -int64(u&1)
	return v, n, nil
}

// decodeUnsignedVarint decodes canonical unsigned LEB128 with the width-based
// byte limit and payload-bit limit required by the wire format.
func decodeUnsignedVarint(data []byte, bits int) (uint64, int, error) {
	maxBytes := 10
	lastBits := 1
	if bits == 32 {
		maxBytes = 5
		lastBits = 4
	}

	var value uint64
	for i := 0; i < maxBytes; i++ {
		if i >= len(data) {
			return 0, 0, fmt.Errorf("%w: truncated varint", ErrInvalidBatch)
		}
		b := data[i]
		payloadBits := 7
		if i == maxBytes-1 {
			payloadBits = lastBits
		}
		if i == maxBytes-1 {
			if b&0x80 != 0 || b>>uint(payloadBits) != 0 {
				return 0, 0, fmt.Errorf("%w: varint overflows %d bits", ErrInvalidBatch, bits)
			}
		}
		value |= uint64(b&0x7f) << uint(7*i)
		if b&0x80 == 0 {
			if i > 0 && b&0x7f == 0 {
				return 0, 0, fmt.Errorf("%w: non-minimal varint", ErrInvalidBatch)
			}
			return value, i + 1, nil
		}
	}
	return 0, 0, fmt.Errorf("%w: varint too long", ErrInvalidBatch)
}

func addInt64(a, b int64) (int64, bool) {
	if (b > 0 && a > math.MaxInt64-b) || (b < 0 && a < math.MinInt64-b) {
		return 0, false
	}
	return a + b, true
}

var crc32cTable = makeCRC32CTable()

func makeCRC32CTable() [256]uint32 {
	const polynomial uint32 = 0x82f63b78
	var table [256]uint32
	for i := range table {
		crc := uint32(i)
		for bit := 0; bit < 8; bit++ {
			if crc&1 != 0 {
				crc = crc>>1 ^ polynomial
			} else {
				crc >>= 1
			}
		}
		table[i] = crc
	}
	return table
}

// CRC32C computes the CRC used by the batch format: reflected Castagnoli
// polynomial 0x82F63B78, initial remainder 0xFFFFFFFF, and a final
// 0xFFFFFFFF XOR.
func CRC32C(data []byte) uint32 {
	crc := uint32(0xffffffff)
	for _, b := range data {
		crc = crc32cTable[byte(crc)^b] ^ crc>>8
	}
	return crc ^ 0xffffffff
}

// Checksum is an alias for CRC32C.
func Checksum(data []byte) uint32 { return CRC32C(data) }
