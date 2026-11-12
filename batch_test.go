package dataeng_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"math"
	"testing"

	de "example.org/dataeng/q0326"
)

type wireHeader struct {
	key          []byte
	value        []byte
	keyMissing   bool
	valueMissing bool
}

type wireRecord struct {
	attributes      byte
	timestampDelta  int64
	offsetDelta     int32
	key             []byte
	keyMissing      bool
	value           []byte
	valueMissing    bool
	headers         []wireHeader
	rawBody         []byte
	rawLengthPrefix []byte
}

type batchSpec struct {
	baseOffset             int64
	leaderEpoch            int32
	attributes             uint16
	lastOffsetDelta        int32
	baseTimestamp          int64
	maxTimestamp           int64
	producerID             int64
	producerEpoch          int16
	baseSequence           int32
	recordsCount           int32
	recordsCountOverridden bool
	records                []wireRecord
	rawRecords             []byte
	batchLengthOverride    *int32
	crcOverride            *uint32
}

func appendU16(dst []byte, v uint16) []byte {
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], v)
	return append(dst, b[:]...)
}

func appendU32(dst []byte, v uint32) []byte {
	var b [4]byte
	binary.BigEndian.PutUint32(b[:], v)
	return append(dst, b[:]...)
}

func appendU64(dst []byte, v uint64) []byte {
	var b [8]byte
	binary.BigEndian.PutUint64(b[:], v)
	return append(dst, b[:]...)
}

func encodeUnsignedVarint(dst []byte, value uint64) []byte {
	for value >= 0x80 {
		dst = append(dst, byte(value)|0x80)
		value >>= 7
	}
	return append(dst, byte(value))
}

func encodeSigned32(dst []byte, value int32) []byte {
	zigzag := uint32(value)<<1 ^ uint32(value>>31)
	return encodeUnsignedVarint(dst, uint64(zigzag))
}

func encodeSigned64(dst []byte, value int64) []byte {
	zigzag := uint64(value)<<1 ^ uint64(value>>63)
	return encodeUnsignedVarint(dst, zigzag)
}

func encodeNullable(dst []byte, value []byte, missing bool) []byte {
	if missing {
		return encodeSigned32(dst, -1)
	}
	dst = encodeSigned32(dst, int32(len(value)))
	return append(dst, value...)
}

func encodeRecordBody(record wireRecord) []byte {
	if record.rawBody != nil {
		return append([]byte(nil), record.rawBody...)
	}
	body := []byte{record.attributes}
	body = encodeSigned64(body, record.timestampDelta)
	body = encodeSigned32(body, record.offsetDelta)
	body = encodeNullable(body, record.key, record.keyMissing)
	body = encodeNullable(body, record.value, record.valueMissing)
	body = encodeSigned32(body, int32(len(record.headers)))
	for _, header := range record.headers {
		if header.keyMissing {
			body = encodeSigned32(body, -1)
		} else {
			body = encodeSigned32(body, int32(len(header.key)))
			body = append(body, header.key...)
		}
		body = encodeNullable(body, header.value, header.valueMissing)
	}
	return body
}

func encodeRecord(record wireRecord) []byte {
	body := encodeRecordBody(record)
	var out []byte
	if record.rawLengthPrefix != nil {
		out = append(out, record.rawLengthPrefix...)
	} else {
		out = encodeSigned32(out, int32(len(body)))
	}
	return append(out, body...)
}

// buildBatch is an independent encoder used only by tests.
func buildBatch(spec batchSpec) []byte {
	out := appendU64(nil, uint64(spec.baseOffset))
	out = appendU32(out, 0) // batchLength placeholder
	out = appendU32(out, uint32(spec.leaderEpoch))
	out = append(out, 2)    // magic
	out = appendU32(out, 0) // CRC placeholder
	if len(out) != 21 {
		panic("bad batch prefix")
	}

	out = appendU16(out, spec.attributes)
	out = appendU32(out, uint32(spec.lastOffsetDelta))
	out = appendU64(out, uint64(spec.baseTimestamp))
	out = appendU64(out, uint64(spec.maxTimestamp))
	out = appendU64(out, uint64(spec.producerID))
	out = appendU16(out, uint16(spec.producerEpoch))
	out = appendU32(out, uint32(spec.baseSequence))

	count := spec.recordsCount
	if !spec.recordsCountOverridden {
		count = int32(len(spec.records))
	}
	out = appendU32(out, uint32(count))

	if spec.rawRecords != nil {
		out = append(out, spec.rawRecords...)
	} else {
		for _, record := range spec.records {
			out = append(out, encodeRecord(record)...)
		}
	}

	length := int32(len(out) - 12)
	if spec.batchLengthOverride != nil {
		length = *spec.batchLengthOverride
	}
	binary.BigEndian.PutUint32(out[8:12], uint32(length))

	crc := testCRC32C(out[21:])
	if spec.crcOverride != nil {
		crc = *spec.crcOverride
	}
	binary.BigEndian.PutUint32(out[17:21], crc)
	return out
}

func testCRC32C(data []byte) uint32 {
	crc := uint32(0xffffffff)
	for _, value := range data {
		crc ^= uint32(value)
		for bit := 0; bit < 8; bit++ {
			if crc&1 != 0 {
				crc = crc>>1 ^ 0x82f63b78
			} else {
				crc >>= 1
			}
		}
	}
	return crc ^ 0xffffffff
}

func push(t *testing.T, parser *de.Parser, data []byte) []de.Batch {
	t.Helper()
	batches, err := parser.Push(data)
	if err != nil {
		t.Fatalf("Push failed: %v", err)
	}
	return batches
}

func collectByOneByte(t *testing.T, data []byte, maxBytes, maxRecords int) []de.Batch {
	t.Helper()
	parser := de.NewParser(maxBytes, maxRecords)
	var batches []de.Batch
	for i := range data {
		batches = append(batches, push(t, parser, data[i:i+1])...)
	}
	if err := parser.Finish(); err != nil {
		t.Fatalf("Finish failed: %v", err)
	}
	return batches
}

func validEmptyBatch(baseOffset, timestamp int64) batchSpec {
	return batchSpec{
		baseOffset:      baseOffset,
		lastOffsetDelta: 0,
		baseTimestamp:   timestamp,
		maxTimestamp:    timestamp,
		producerID:      -1,
		producerEpoch:   -1,
		baseSequence:    -1,
	}
}

func TestCRC32CKnownVector(t *testing.T) {
	if got := de.CRC32C([]byte("123456789")); got != 0xe3069283 {
		t.Fatalf("CRC32C(123456789) = %#08x, want 0xE3069283", got)
	}
	if got := de.Checksum([]byte("123456789")); got != 0xe3069283 {
		t.Fatalf("Checksum(123456789) = %#08x, want 0xE3069283", got)
	}
}

func TestEmptyBatchAndKnownLength(t *testing.T) {
	spec := validEmptyBatch(7, -42)
	data := buildBatch(spec)
	if len(data) != 61 {
		t.Fatalf("empty batch length = %d, want 61", len(data))
	}
	if got := binary.BigEndian.Uint32(data[8:12]); got != 49 {
		t.Fatalf("batchLength = %d, want 49", got)
	}

	batches := collectByOneByte(t, data, 61, 0)
	if len(batches) != 1 {
		t.Fatalf("got %d batches, want 1", len(batches))
	}
	batch := batches[0]
	if batch.BaseOffset != 7 || batch.BaseTimestamp != -42 || batch.MaxTimestamp != -42 {
		t.Fatalf("unexpected empty batch: %+v", batch)
	}
	if batch.RecordsCount != 0 || len(batch.Records) != 0 {
		t.Fatalf("unexpected records: %+v", batch.Records)
	}
	if batch.Start != 0 || batch.End != 61 {
		t.Fatalf("range = [%d,%d), want [0,61)", batch.Start, batch.End)
	}
}

func TestReassemblesEverySplitBoundaryAndAdjacentBatches(t *testing.T) {
	create := batchSpec{
		baseOffset:      100,
		attributes:      0,
		lastOffsetDelta: 2,
		baseTimestamp:   1000,
		maxTimestamp:    1005,
		producerID:      -1,
		producerEpoch:   -1,
		baseSequence:    -1,
		records: []wireRecord{
			{
				timestampDelta: 0,
				offsetDelta:    0,
				key:            []byte("a"),
				value:          []byte("v"),
			},
			{
				timestampDelta: 5,
				offsetDelta:    2,
				keyMissing:     true,
				valueMissing:   true,
				headers: []wireHeader{
					{key: []byte("h"), value: []byte("one")},
					{key: []byte("h"), value: []byte("two")},
				},
			},
		},
	}
	appendBatch := batchSpec{
		baseOffset:      300,
		attributes:      0x0008,
		lastOffsetDelta: 1,
		baseTimestamp:   50,
		maxTimestamp:    9000,
		producerID:      8,
		producerEpoch:   3,
		baseSequence:    2147483647,
		records: []wireRecord{
			{timestampDelta: 0, offsetDelta: 0, value: []byte{}},
			{timestampDelta: 0, offsetDelta: 1, value: []byte{}},
		},
	}

	first := buildBatch(create)
	second := buildBatch(appendBatch)
	stream := append(append([]byte(nil), first...), second...)

	for split := 0; split <= len(stream); split++ {
		parser := de.NewParser(len(stream)+1, 5)
		batches := append(push(t, parser, stream[:split]), push(t, parser, stream[split:])...)
		if err := parser.Finish(); err != nil {
			t.Fatalf("split %d: Finish: %v", split, err)
		}
		if len(batches) != 2 {
			t.Fatalf("split %d: got %d batches", split, len(batches))
		}
		if batches[0].Start != 0 || batches[0].End != int64(len(first)) ||
			batches[1].Start != int64(len(first)) || batches[1].End != int64(len(stream)) {
			t.Fatalf("split %d: wrong ranges [%d,%d) [%d,%d)", split,
				batches[0].Start, batches[0].End, batches[1].Start, batches[1].End)
		}
	}

	batches := collectByOneByte(t, stream, len(stream)+1, 5)
	firstBatch := batches[0]
	if firstBatch.TimestampType() != de.CreateTime {
		t.Fatalf("timestamp type = %v", firstBatch.TimestampType())
	}
	if firstBatch.Records[0].Offset != 100 || firstBatch.Records[0].Timestamp != 1000 {
		t.Fatalf("record 0: %+v", firstBatch.Records[0])
	}
	if !bytes.Equal(firstBatch.Records[0].Key, []byte("a")) ||
		!bytes.Equal(firstBatch.Records[0].Value, []byte("v")) {
		t.Fatalf("record 0 bytes: %+v", firstBatch.Records[0])
	}
	if firstBatch.Records[1].Offset != 102 || firstBatch.Records[1].Key != nil ||
		firstBatch.Records[1].Value != nil {
		t.Fatalf("record 1 null handling: %+v", firstBatch.Records[1])
	}
	if len(firstBatch.Records[1].Headers) != 2 ||
		string(firstBatch.Records[1].Headers[0].Key) != "h" ||
		string(firstBatch.Records[1].Headers[1].Value) != "two" {
		t.Fatalf("headers not preserved: %+v", firstBatch.Records[1].Headers)
	}
	if firstBatch.Records[0].HasSequence || firstBatch.Records[1].HasSequence {
		t.Fatalf("records unexpectedly have sequences")
	}

	secondBatch := batches[1]
	if secondBatch.TimestampType() != de.AppendTime || secondBatch.BaseTimestamp != 50 {
		t.Fatalf("append batch metadata: %+v", secondBatch)
	}
	if secondBatch.Records[0].Timestamp != 9000 || secondBatch.Records[1].Timestamp != 9000 {
		t.Fatalf("append timestamps: %+v", secondBatch.Records)
	}
	if !secondBatch.Records[0].HasSequence ||
		secondBatch.Records[0].Sequence != 2147483647 ||
		secondBatch.Records[1].Sequence != 2147483648 {
		t.Fatalf("sequence wrap: %+v", secondBatch.Records)
	}
}

func TestImmediateBudgetRejectionAtLengthField(t *testing.T) {
	spec := validEmptyBatch(0, 0)
	spec.rawRecords = bytes.Repeat([]byte{0}, 300)
	spec.batchLengthOverride = ptr(int32(49 + 300))
	data := buildBatch(spec)

	parser := de.NewParser(100, 10)
	batches, err := parser.Push(data)
	if len(batches) != 0 {
		t.Fatalf("delivered batches on immediate rejection: %d", len(batches))
	}
	if !errors.Is(err, de.ErrBatchTooLarge) {
		t.Fatalf("err = %v, want ErrBatchTooLarge", err)
	}
	if parser.Pending() != 12 {
		t.Fatalf("pending = %d, want 12", parser.Pending())
	}
	batches, err2 := parser.Push(data[12:])
	if len(batches) != 0 || err2 != err {
		t.Fatalf("failure not sticky: batches=%d err2=%v err=%v", len(batches), err2, err)
	}
}

func TestPartialResultsSurviveLaterFailure(t *testing.T) {
	spec := validEmptyBatch(5, 10)
	good := buildBatch(spec)

	badHeader := make([]byte, 12)
	binary.BigEndian.PutUint32(badHeader[8:12], 48)
	stream := append(append([]byte(nil), good...), badHeader...)

	parser := de.NewParser(len(stream)+1, 10)
	batches, err := parser.Push(stream)
	if len(batches) != 1 || !errors.Is(err, de.ErrBatchTooSmall) {
		t.Fatalf("got %d batches, err=%v", len(batches), err)
	}
	if batches[0].Start != 0 || batches[0].End != int64(len(good)) {
		t.Fatalf("delivered batch range = [%d,%d)", batches[0].Start, batches[0].End)
	}
	if _, err2 := parser.Push([]byte{0}); err2 != err {
		t.Fatalf("sticky error = %v, want %v", err2, err)
	}
}

func TestLengthBelowMinimumRejectedImmediately(t *testing.T) {
	header := make([]byte, 12)
	binary.BigEndian.PutUint32(header[8:12], 48)
	parser := de.NewParser(1000, 10)
	_, err := parser.Push(header)
	if !errors.Is(err, de.ErrBatchTooSmall) {
		t.Fatalf("err = %v, want ErrBatchTooSmall", err)
	}
}

func TestCompressedBatchRejected(t *testing.T) {
	spec := validEmptyBatch(0, 0)
	spec.attributes = 1
	data := buildBatch(spec)
	parser := de.NewParser(100, 10)
	_, err := parser.Push(data)
	if !errors.Is(err, de.ErrInvalidBatch) {
		t.Fatalf("err = %v, want ErrInvalidBatch", err)
	}
}

func TestOverlongVarintsRejected(t *testing.T) {
	t.Run("record length", func(t *testing.T) {
		prefix := []byte{0x80, 0x80, 0x80, 0x80, 0x80, 0x00}
		spec := validEmptyBatch(0, 0)
		spec.recordsCount = 1
		spec.recordsCountOverridden = true
		spec.rawRecords = prefix
		data := buildBatch(spec)
		parser := de.NewParser(len(data), 10)
		_, err := parser.Push(data)
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v, want ErrInvalidBatch", err)
		}
	})

	t.Run("timestamp long", func(t *testing.T) {
		body := []byte{0}
		for i := 0; i < 10; i++ {
			body = append(body, 0x80)
		}
		body = append(body, 0)
		spec := validEmptyBatch(0, 0)
		spec.recordsCount = 1
		spec.recordsCountOverridden = true
		spec.rawRecords = append(encodeSigned32(nil, int32(len(body))), body...)
		data := buildBatch(spec)
		parser := de.NewParser(len(data), 10)
		_, err := parser.Push(data)
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v, want ErrInvalidBatch", err)
		}
	})

	t.Run("non minimal", func(t *testing.T) {
		prefix := []byte{0x81, 0x00} // zigzag 1 encoded in two bytes
		spec := validEmptyBatch(0, 0)
		spec.recordsCount = 1
		spec.recordsCountOverridden = true
		spec.rawRecords = append(prefix, 0)
		data := buildBatch(spec)
		parser := de.NewParser(len(data), 10)
		_, err := parser.Push(data)
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v, want ErrInvalidBatch", err)
		}
	})
}

func TestMagicAndReservedAttributeBitsRejected(t *testing.T) {
	t.Run("magic", func(t *testing.T) {
		data := buildBatch(validEmptyBatch(0, 0))
		data[16] = 1
		parser := de.NewParser(100, 10)
		_, err := parser.Push(data)
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("reserved attributes", func(t *testing.T) {
		spec := validEmptyBatch(0, 0)
		spec.attributes = 0x0040
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(spec))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestOffsetRegressionRejected(t *testing.T) {
	spec := batchSpec{
		baseOffset:      10,
		lastOffsetDelta: 2,
		baseTimestamp:   1,
		maxTimestamp:    1,
		producerID:      -1,
		producerEpoch:   -1,
		baseSequence:    -1,
		records: []wireRecord{
			{offsetDelta: 3},
			{offsetDelta: 2},
		},
	}
	parser := de.NewParser(100, 10)
	_, err := parser.Push(buildBatch(spec))
	if !errors.Is(err, de.ErrInvalidBatch) {
		t.Fatalf("err = %v, want ErrInvalidBatch", err)
	}
}

func TestOffsetOverflowAndLastDeltaMismatchRejected(t *testing.T) {
	t.Run("absolute overflow", func(t *testing.T) {
		spec := batchSpec{
			baseOffset:      math.MaxInt64,
			lastOffsetDelta: 1,
			baseTimestamp:   0,
			maxTimestamp:    0,
			producerID:      -1,
			producerEpoch:   -1,
			baseSequence:    -1,
			records:         []wireRecord{{offsetDelta: 1}},
		}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(spec))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("last delta", func(t *testing.T) {
		spec := batchSpec{
			lastOffsetDelta: 3,
			baseTimestamp:   0,
			maxTimestamp:    0,
			producerID:      -1,
			producerEpoch:   -1,
			baseSequence:    -1,
			records:         []wireRecord{{offsetDelta: 2}},
		}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(spec))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestTimestampOverflowRejected(t *testing.T) {
	spec := batchSpec{
		baseOffset:      0,
		lastOffsetDelta: 0,
		baseTimestamp:   math.MaxInt64,
		maxTimestamp:    math.MaxInt64,
		producerID:      -1,
		producerEpoch:   -1,
		baseSequence:    -1,
		records: []wireRecord{
			{timestampDelta: 1, offsetDelta: 0},
		},
	}
	parser := de.NewParser(100, 10)
	_, err := parser.Push(buildBatch(spec))
	if !errors.Is(err, de.ErrInvalidBatch) {
		t.Fatalf("err = %v, want ErrInvalidBatch", err)
	}
}

func TestMaxTimestampMismatchRejected(t *testing.T) {
	t.Run("create time", func(t *testing.T) {
		spec := batchSpec{
			lastOffsetDelta: 0,
			baseTimestamp:   10,
			maxTimestamp:    100,
			producerID:      -1,
			producerEpoch:   -1,
			baseSequence:    -1,
			records:         []wireRecord{{timestampDelta: 1, offsetDelta: 0}},
		}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(spec))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("empty", func(t *testing.T) {
		spec := validEmptyBatch(0, 1)
		spec.maxTimestamp = 2
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(spec))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestSequenceCrossesInt32Boundary(t *testing.T) {
	spec := batchSpec{
		baseOffset:      0,
		lastOffsetDelta: 3,
		baseTimestamp:   0,
		maxTimestamp:    0,
		producerID:      9,
		producerEpoch:   2,
		baseSequence:    2147483647,
		records: []wireRecord{
			{offsetDelta: 0},
			{offsetDelta: 1},
			{offsetDelta: 2},
			{offsetDelta: 3},
		},
	}
	parser := de.NewParser(100, 10)
	batches, err := parser.Push(buildBatch(spec))
	if err != nil {
		t.Fatal(err)
	}
	got := batches[0].Records
	if got[0].Sequence != 2147483647 || got[1].Sequence != 2147483648 ||
		got[2].Sequence != 2147483649 || got[3].Sequence != 2147483650 {
		t.Fatalf("sequences = %d %d %d %d", got[0].Sequence, got[1].Sequence, got[2].Sequence, got[3].Sequence)
	}
	for i := range got {
		if !got[i].HasSequence {
			t.Fatalf("record %d has no sequence", i)
		}
	}
}

func TestControlRecords(t *testing.T) {
	key := []byte{0, 0, 0, 0}
	key[3] = 1
	spec := batchSpec{
		baseOffset:      0,
		attributes:      0x0020,
		lastOffsetDelta: 0,
		baseTimestamp:   10,
		maxTimestamp:    10,
		producerID:      3,
		producerEpoch:   0,
		baseSequence:    0,
		records: []wireRecord{
			{offsetDelta: 0, key: key, valueMissing: true},
		},
	}
	parser := de.NewParser(100, 10)
	batches, err := parser.Push(buildBatch(spec))
	if err != nil {
		t.Fatal(err)
	}
	record := batches[0].Records[0]
	if !batches[0].Control() || record.ControlType == nil || *record.ControlType != de.ControlCommit {
		t.Fatalf("control metadata not decoded: control=%v type=%v", batches[0].Control(), record.ControlType)
	}

	t.Run("bad version", func(t *testing.T) {
		bad := spec
		bad.records = []wireRecord{{offsetDelta: 0, key: []byte{1, 0, 0, 0}, valueMissing: true}}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(bad))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("bad type", func(t *testing.T) {
		bad := spec
		bad.records = []wireRecord{{offsetDelta: 0, key: []byte{0, 0, 0, 2}, valueMissing: true}}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(bad))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("value present", func(t *testing.T) {
		bad := spec
		bad.records = []wireRecord{{offsetDelta: 0, key: key, value: []byte{}}}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(bad))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("headers present", func(t *testing.T) {
		bad := spec
		bad.records = []wireRecord{{
			offsetDelta:  0,
			key:          key,
			valueMissing: true,
			headers:      []wireHeader{{key: []byte("x"), valueMissing: true}},
		}}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(bad))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestProducerAndTransactionContradictions(t *testing.T) {
	spec := validEmptyBatch(0, 0)
	spec.attributes = 0x0010
	parser := de.NewParser(100, 10)
	_, err := parser.Push(buildBatch(spec))
	if !errors.Is(err, de.ErrInvalidBatch) {
		t.Fatalf("unsequenced transaction err = %v", err)
	}

	spec = validEmptyBatch(0, 0)
	spec.producerID = 1
	parser = de.NewParser(100, 10)
	_, err = parser.Push(buildBatch(spec))
	if !errors.Is(err, de.ErrInvalidBatch) {
		t.Fatalf("sequenced record without epoch err = %v", err)
	}
}

func TestCRCTamperingRejected(t *testing.T) {
	spec := validEmptyBatch(0, 0)
	data := buildBatch(spec)
	data[23] ^= 0x01
	parser := de.NewParser(100, 10)
	_, err := parser.Push(data)
	if !errors.Is(err, de.ErrBadCRC) {
		t.Fatalf("err = %v, want ErrBadCRC", err)
	}
}

func TestRecordCountAndMaxRecords(t *testing.T) {
	spec := batchSpec{
		baseOffset:      0,
		lastOffsetDelta: 1,
		baseTimestamp:   0,
		maxTimestamp:    0,
		producerID:      -1,
		producerEpoch:   -1,
		baseSequence:    -1,
		records: []wireRecord{
			{offsetDelta: 0},
			{offsetDelta: 1},
		},
	}
	data := buildBatch(spec)
	parser := de.NewParser(len(data), 1)
	_, err := parser.Push(data)
	if !errors.Is(err, de.ErrRecordCount) {
		t.Fatalf("max records err = %v", err)
	}

	spec.recordsCount = 1
	spec.recordsCountOverridden = true
	parser = de.NewParser(len(data), 10)
	_, err = parser.Push(buildBatch(spec))
	if !errors.Is(err, de.ErrRecordCount) {
		t.Fatalf("count mismatch err = %v", err)
	}
}

func TestAppendTimeRejectsNonzeroDelta(t *testing.T) {
	spec := batchSpec{
		baseOffset:      0,
		attributes:      0x0008,
		lastOffsetDelta: 0,
		baseTimestamp:   10,
		maxTimestamp:    20,
		producerID:      -1,
		producerEpoch:   -1,
		baseSequence:    -1,
		records:         []wireRecord{{timestampDelta: 1, offsetDelta: 0}},
	}
	parser := de.NewParser(100, 10)
	_, err := parser.Push(buildBatch(spec))
	if !errors.Is(err, de.ErrInvalidBatch) {
		t.Fatalf("append delta err = %v", err)
	}
}

func TestFinishWithResidualFailsAndSticks(t *testing.T) {
	parser := de.NewParser(1000, 10)
	prefix := make([]byte, 12)
	binary.BigEndian.PutUint32(prefix[8:12], 49)
	_, err := parser.Push(prefix)
	if err != nil {
		t.Fatal(err)
	}
	finishErr := parser.Finish()
	if !errors.Is(finishErr, de.ErrTrailingData) {
		t.Fatalf("Finish err = %v", finishErr)
	}
	if _, err2 := parser.Push(nil); err2 != finishErr {
		t.Fatalf("Push after failed Finish: %v", err2)
	}
}

func TestMalformedHeaderFieldRules(t *testing.T) {
	t.Run("record attributes", func(t *testing.T) {
		spec := batchSpec{
			lastOffsetDelta: 0, producerID: -1, producerEpoch: -1, baseSequence: -1,
			records: []wireRecord{{attributes: 1, offsetDelta: 0}},
		}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(spec))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("negative header count", func(t *testing.T) {
		body := []byte{0}
		body = encodeSigned64(body, 0)
		body = encodeSigned32(body, 0)
		body = encodeSigned32(body, -1)
		body = encodeSigned32(body, -1)
		body = encodeSigned32(body, -2)
		spec := validEmptyBatch(0, 0)
		spec.recordsCount = 1
		spec.recordsCountOverridden = true
		spec.rawRecords = append(encodeSigned32(nil, int32(len(body))), body...)
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(spec))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("empty header key", func(t *testing.T) {
		spec := batchSpec{
			lastOffsetDelta: 0, producerID: -1, producerEpoch: -1, baseSequence: -1,
			records: []wireRecord{{
				offsetDelta: 0,
				headers:     []wireHeader{{key: []byte{}, valueMissing: true}},
			}},
		}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(spec))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})

	t.Run("key length below minus one", func(t *testing.T) {
		body := []byte{0}
		body = encodeSigned64(body, 0)
		body = encodeSigned32(body, 0)
		body = encodeSigned32(body, -2)
		spec := batchSpec{
			lastOffsetDelta: 0, producerID: -1, producerEpoch: -1, baseSequence: -1,
			records: []wireRecord{{
				offsetDelta: 0,
				rawBody:     body,
			}},
		}
		parser := de.NewParser(100, 10)
		_, err := parser.Push(buildBatch(spec))
		if !errors.Is(err, de.ErrInvalidBatch) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestExactMaxBatchBytesAccepted(t *testing.T) {
	spec := validEmptyBatch(0, 0)
	data := buildBatch(spec)
	parser := de.NewParser(len(data), 0)
	batches, err := parser.Push(data)
	if err != nil || len(batches) != 1 {
		t.Fatalf("Push: batches=%d err=%v", len(batches), err)
	}
}

func TestDeliveredRecordsDoNotAliasInput(t *testing.T) {
	spec := batchSpec{
		baseOffset:      0,
		lastOffsetDelta: 0,
		baseTimestamp:   0,
		maxTimestamp:    0,
		producerID:      -1,
		producerEpoch:   -1,
		baseSequence:    -1,
		records: []wireRecord{{
			offsetDelta: 0,
			key:         []byte("key"),
			value:       []byte("value"),
			headers:     []wireHeader{{key: []byte("header"), value: []byte("data")}},
		}},
	}
	data := buildBatch(spec)
	parser := de.NewParser(len(data), 10)
	batches, err := parser.Push(data)
	if err != nil {
		t.Fatal(err)
	}
	batch := batches[0]

	for i := range data {
		data[i] = 0xff
	}
	if !bytes.Equal(batch.Records[0].Key, []byte("key")) ||
		!bytes.Equal(batch.Records[0].Value, []byte("value")) ||
		!bytes.Equal(batch.Records[0].Headers[0].Key, []byte("header")) ||
		!bytes.Equal(batch.Records[0].Headers[0].Value, []byte("data")) {
		t.Fatalf("batch aliases its input: %+v", batch.Records[0])
	}
}

func TestConfigConstructor(t *testing.T) {
	parser := de.NewParser(de.Config{MaxBatchBytes: 61, MaxRecords: 0})
	data := buildBatch(validEmptyBatch(0, 0))
	batches, err := parser.Push(data)
	if err != nil || len(batches) != 1 {
		t.Fatalf("Push: batches=%d err=%v", len(batches), err)
	}
	if err := parser.Finish(); err != nil {
		t.Fatal(err)
	}
}

func ptr[T any](value T) *T { return &value }
