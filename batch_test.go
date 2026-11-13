package dataeng_test

import (
	"bytes"
	"encoding/binary"
	"errors"
	"testing"

	dataeng "example.org/dataeng13/q0036"
)

func TestOffsetsTimestampsAndPayloads(t *testing.T) {
	const (
		baseOffset    = int64(1000)
		baseTimestamp = int64(1_700_000_000_000)
	)
	batch := newWireBatch(baseOffset, baseTimestamp, baseTimestamp, 3,
		wireRecord{offsetDelta: 0, timestampDelta: -20, key: []byte("k0"), value: []byte("v0")},
		wireRecord{offsetDelta: 1, timestampDelta: -7, nullKey: true, value: []byte("v1")},
		wireRecord{offsetDelta: 3, timestampDelta: 0, value: []byte("v3"), headers: []wireHeader{{
			key: []byte("hdr"), value: []byte("hv"),
		}, {
			key: []byte("empty"), nullValue: true,
		}}},
	)

	got, err := dataeng.ParseBatch(encodeBatch(batch))
	if err != nil {
		t.Fatalf("ParseBatch: %v", err)
	}
	if len(got.Records) != 3 {
		t.Fatalf("record count = %d, want 3", len(got.Records))
	}
	if got.LastOffset() != 1003 {
		t.Fatalf("LastOffset = %d, want 1003", got.LastOffset())
	}

	ledger := []struct {
		offset    int64
		timestamp int64
		nullKey   bool
	}{
		{offset: 1000, timestamp: baseTimestamp - 20},
		{offset: 1001, timestamp: baseTimestamp - 7, nullKey: true},
		{offset: 1003, timestamp: baseTimestamp},
	}
	for i, want := range ledger {
		record := got.Records[i]
		if record.Offset != want.offset {
			t.Errorf("record %d offset = %d, want %d", i, record.Offset, want.offset)
		}
		if record.Timestamp != want.timestamp {
			t.Errorf("record %d timestamp = %d, want %d", i, record.Timestamp, want.timestamp)
		}
		if want.nullKey && record.Key != nil {
			t.Errorf("record %d key = %q, want null", i, record.Key)
		} else if !want.nullKey && record.Key == nil {
			t.Errorf("record %d key is null", i)
		}
	}

	if !bytes.Equal(got.Records[0].Key, []byte("k0")) {
		t.Errorf("record 0 key = %q, want k0", got.Records[0].Key)
	}
	if !bytes.Equal(got.Records[0].Value, []byte("v0")) {
		t.Errorf("record 0 value = %q, want v0", got.Records[0].Value)
	}
	if !bytes.Equal(got.Records[2].Value, []byte("v3")) {
		t.Errorf("record 2 value = %q, want v3", got.Records[2].Value)
	}
	if len(got.Records[2].Headers) != 2 {
		t.Fatalf("record 2 header count = %d, want 2", len(got.Records[2].Headers))
	}
	if !bytes.Equal(got.Records[2].Headers[0].Key, []byte("hdr")) ||
		!bytes.Equal(got.Records[2].Headers[0].Value, []byte("hv")) {
		t.Errorf("record 2 header = %q:%q, want hdr:hv",
			got.Records[2].Headers[0].Key, got.Records[2].Headers[0].Value)
	}
	if got.Records[2].Headers[1].Value != nil {
		t.Errorf("record 2 null header value = %q, want null", got.Records[2].Headers[1].Value)
	}

	if got.Records[0].OffsetDelta != 0 || got.Records[1].OffsetDelta != 1 || got.Records[2].OffsetDelta != 3 {
		t.Errorf("offset delta fields = %d,%d,%d, want 0,1,3",
			got.Records[0].OffsetDelta, got.Records[1].OffsetDelta, got.Records[2].OffsetDelta)
	}
	if got.Records[1].TimestampDelta != -7 {
		t.Errorf("record 1 timestamp delta = %d, want -7", got.Records[1].TimestampDelta)
	}
}

func TestLastOffsetLedger(t *testing.T) {
	const baseOffset = int64(700)
	tests := []struct {
		name       string
		lastDelta  int32
		deltas     []int32
		wantErr    error
		wantOffset int64
	}{
		{
			name:       "matching ledger",
			lastDelta:  3,
			deltas:     []int32{0, 1, 3},
			wantOffset: 703,
		},
		{
			name:      "last delta too small",
			lastDelta: 2,
			deltas:    []int32{0, 1, 3},
			wantErr:   dataeng.ErrLastOffsetMismatch,
		},
		{
			name:      "last delta too large",
			lastDelta: 4,
			deltas:    []int32{0, 1, 3},
			wantErr:   dataeng.ErrLastOffsetMismatch,
		},
		{
			name:      "negative offset delta",
			lastDelta: 0,
			deltas:    []int32{0, -1},
			wantErr:   dataeng.ErrInvalidOffsetDelta,
		},
		{
			name:      "unordered offsets",
			lastDelta: 0,
			deltas:    []int32{0, 0},
			wantErr:   dataeng.ErrRecordOrder,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			records := make([]wireRecord, 0, len(test.deltas))
			for _, delta := range test.deltas {
				records = append(records, wireRecord{offsetDelta: delta})
			}
			batch := newWireBatch(baseOffset, 5000, 5000, test.lastDelta, records...)
			got, err := dataeng.ParseBatch(encodeBatch(batch))
			if test.wantErr != nil {
				if !errors.Is(err, test.wantErr) {
					t.Fatalf("error = %v, want %v", err, test.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseBatch: %v", err)
			}
			last := got.Records[len(got.Records)-1]
			if last.Offset != test.wantOffset {
				t.Errorf("last record offset = %d, want %d", last.Offset, test.wantOffset)
			}
			if got.BaseOffset+int64(got.LastOffsetDelta) != last.Offset {
				t.Errorf("base %d + last delta %d = %d, want last offset %d",
					got.BaseOffset, got.LastOffsetDelta, got.BaseOffset+int64(got.LastOffsetDelta), last.Offset)
			}
		})
	}
}

func TestTimestampDeltaDirection(t *testing.T) {
	const baseTimestamp = int64(2_000)

	t.Run("equal to maximum is allowed", func(t *testing.T) {
		batch := newWireBatch(10, baseTimestamp, baseTimestamp+10, 0,
			wireRecord{offsetDelta: 0, timestampDelta: 10})
		got, err := dataeng.ParseBatch(encodeBatch(batch))
		if err != nil {
			t.Fatalf("ParseBatch: %v", err)
		}
		if got.Records[0].Timestamp != baseTimestamp+10 {
			t.Fatalf("timestamp = %d, want %d", got.Records[0].Timestamp, baseTimestamp+10)
		}
	})

	t.Run("before maximum is allowed", func(t *testing.T) {
		batch := newWireBatch(10, baseTimestamp, baseTimestamp, 0,
			wireRecord{offsetDelta: 0, timestampDelta: -150})
		got, err := dataeng.ParseBatch(encodeBatch(batch))
		if err != nil {
			t.Fatalf("ParseBatch: %v", err)
		}
		if got.Records[0].Timestamp != baseTimestamp-150 {
			t.Fatalf("timestamp = %d, want %d", got.Records[0].Timestamp, baseTimestamp-150)
		}
	})

	t.Run("after maximum is rejected", func(t *testing.T) {
		batch := newWireBatch(10, baseTimestamp, baseTimestamp, 0,
			wireRecord{offsetDelta: 0, timestampDelta: 1})
		_, err := dataeng.ParseBatch(encodeBatch(batch))
		if !errors.Is(err, dataeng.ErrTimestampAfterMax) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrTimestampAfterMax)
		}
	})
}

func TestTransactionMarkersRetained(t *testing.T) {
	const baseOffset = int64(50)
	business := []wireRecord{
		{offsetDelta: 0, value: []byte("payload-a")},
		{offsetDelta: 1, value: []byte("payload-b")},
	}

	tests := []struct {
		name       string
		marker     int16
		wantMarker dataeng.MarkerType
	}{
		{name: "commit", marker: 1, wantMarker: dataeng.MarkerCommit},
		{name: "abort", marker: 0, wantMarker: dataeng.MarkerAbort},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			records := append([]wireRecord{}, business...)
			records = append(records, wireRecord{offsetDelta: 2, control: true, marker: test.marker})
			batch := newWireBatch(baseOffset, 9000, 9000, 2, records...)
			batch.attributes = 0x30

			got, err := dataeng.ParseBatch(encodeBatch(batch))
			if err != nil {
				t.Fatalf("ParseBatch: %v", err)
			}
			if len(got.Records) != 3 {
				t.Fatalf("record count = %d, want 3", len(got.Records))
			}
			if !bytes.Equal(got.Records[0].Value, []byte("payload-a")) {
				t.Errorf("business record 0 was not retained: value = %q", got.Records[0].Value)
			}
			if !bytes.Equal(got.Records[1].Value, []byte("payload-b")) {
				t.Errorf("business record 1 was not retained: value = %q", got.Records[1].Value)
			}
			if got.Records[0].Control || got.Records[1].Control {
				t.Errorf("business records were marked as control records")
			}
			if !got.Records[2].Control {
				t.Errorf("marker record is not marked as control")
			}
			if got.Records[2].Marker != test.wantMarker {
				t.Errorf("marker = %v, want %v", got.Records[2].Marker, test.wantMarker)
			}
			if got.Records[2].Offset != 52 {
				t.Errorf("marker offset = %d, want 52", got.Records[2].Offset)
			}
			if !got.IsControl() {
				t.Errorf("batch control attribute was lost")
			}
			if !got.Transactional() {
				t.Errorf("batch transactional attribute was lost")
			}
		})
	}
}

func TestUnknownTransactionMarkerRejected(t *testing.T) {
	batch := newWireBatch(1, 100, 100, 0, wireRecord{offsetDelta: 0, control: true, marker: 7})
	_, err := dataeng.ParseBatch(encodeBatch(batch))
	if !errors.Is(err, dataeng.ErrUnknownTransactionMarker) {
		t.Fatalf("error = %v, want %v", err, dataeng.ErrUnknownTransactionMarker)
	}
}

func TestBusinessRecordsAfterMarkerRetained(t *testing.T) {
	batch := newWireBatch(30, 100, 100, 2,
		wireRecord{offsetDelta: 0, value: []byte("before")},
		wireRecord{offsetDelta: 1, control: true, marker: 1},
		wireRecord{offsetDelta: 2, value: []byte("after")},
	)
	got, err := dataeng.ParseBatch(encodeBatch(batch))
	if err != nil {
		t.Fatalf("ParseBatch: %v", err)
	}
	if len(got.Records) != 3 {
		t.Fatalf("record count = %d, want 3", len(got.Records))
	}
	if !bytes.Equal(got.Records[0].Value, []byte("before")) {
		t.Errorf("record before marker = %q, want before", got.Records[0].Value)
	}
	if !bytes.Equal(got.Records[2].Value, []byte("after")) {
		t.Errorf("record after marker = %q, want after", got.Records[2].Value)
	}
	if got.Records[1].Marker != dataeng.MarkerCommit {
		t.Errorf("marker = %v, want commit", got.Records[1].Marker)
	}
}

func TestBusinessRecordWithMarkerLikeKeyIsRetained(t *testing.T) {
	batch := newWireBatch(1, 100, 100, 0,
		wireRecord{offsetDelta: 0, key: []byte{0, 0, 0, 1}, value: []byte("business")})
	got, err := dataeng.ParseBatch(encodeBatch(batch))
	if err != nil {
		t.Fatalf("ParseBatch: %v", err)
	}
	if got.Records[0].Control {
		t.Fatalf("business record was treated as a control record")
	}
	if got.Records[0].Marker != dataeng.MarkerNone {
		t.Fatalf("marker = %v, want none", got.Records[0].Marker)
	}
}

func TestMalformedVarintRejected(t *testing.T) {
	body := []byte{
		0x00,
		0x00,
		0x80, 0x80, 0x80, 0x80, 0x10,
	}
	batch := newWireBatch(1, 100, 100, 0, wireRecord{offsetDelta: 0, rawBody: body})
	_, err := dataeng.ParseBatch(encodeBatch(batch))
	if !errors.Is(err, dataeng.ErrInvalidVarint) {
		t.Fatalf("error = %v, want %v", err, dataeng.ErrInvalidVarint)
	}
}

func TestRecordLengthLimit(t *testing.T) {
	record := wireRecord{offsetDelta: 0, timestampDelta: 0, value: []byte("0123456789")}
	encoded := encodeRecord(record)
	declaredLength := int(binary.BigEndian.Uint32(encoded[:4]))

	t.Run("at limit accepted", func(t *testing.T) {
		batch := newWireBatch(1, 100, 100, 0, record)
		got, err := dataeng.ParseBatchWithLimit(encodeBatch(batch), declaredLength)
		if err != nil {
			t.Fatalf("ParseBatchWithLimit: %v", err)
		}
		if len(got.Records) != 1 {
			t.Fatalf("record count = %d, want 1", len(got.Records))
		}
	})

	t.Run("one byte over limit rejected", func(t *testing.T) {
		batch := newWireBatch(1, 100, 100, 0, record)
		_, err := dataeng.ParseBatchWithLimit(encodeBatch(batch), declaredLength-1)
		if !errors.Is(err, dataeng.ErrRecordTooLarge) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrRecordTooLarge)
		}
	})

	t.Run("oversized length rejected before body is read", func(t *testing.T) {
		hugeLength := []byte{0x7f, 0xff, 0xff, 0xff}
		batch := wireBatch{
			baseOffset:      1,
			magic:           2,
			lastOffsetDelta: 0,
			baseTimestamp:   100,
			maxTimestamp:    100,
			rawRecords:      hugeLength,
		}
		_, err := dataeng.ParseBatchWithLimit(encodeBatch(batch), 1024)
		if !errors.Is(err, dataeng.ErrRecordTooLarge) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrRecordTooLarge)
		}
		if errors.Is(err, dataeng.ErrTruncated) {
			t.Fatalf("error = %v, length limit must be checked before the missing body", err)
		}
	})

	t.Run("zero length record rejected", func(t *testing.T) {
		batch := wireBatch{
			baseOffset:      1,
			magic:           2,
			lastOffsetDelta: 0,
			baseTimestamp:   100,
			maxTimestamp:    100,
			rawRecords:      []byte{0, 0, 0, 0},
		}
		_, err := dataeng.ParseBatch(encodeBatch(batch))
		if !errors.Is(err, dataeng.ErrInvalidRecord) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrInvalidRecord)
		}
	})
}

func TestBatchEnvelopeValidation(t *testing.T) {
	batch := newWireBatch(0, 0, 0, 0, wireRecord{offsetDelta: 0})
	good := encodeBatch(batch)

	t.Run("unsupported magic", func(t *testing.T) {
		data := append([]byte{}, good...)
		data[16] = 1
		_, err := dataeng.ParseBatch(data)
		if !errors.Is(err, dataeng.ErrUnsupportedMagic) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrUnsupportedMagic)
		}
	})

	t.Run("compressed batch rejected", func(t *testing.T) {
		data := append([]byte{}, good...)
		binary.BigEndian.PutUint16(data[21:23], 1)
		_, err := dataeng.ParseBatch(data)
		if !errors.Is(err, dataeng.ErrUnsupportedCompression) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrUnsupportedCompression)
		}
	})

	t.Run("trailing bytes rejected", func(t *testing.T) {
		data := append([]byte{}, good...)
		data = append(data, 0)
		_, err := dataeng.ParseBatch(data)
		if !errors.Is(err, dataeng.ErrInvalidBatch) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrInvalidBatch)
		}
	})

	t.Run("truncated batch", func(t *testing.T) {
		_, err := dataeng.ParseBatch(good[:len(good)-1])
		if !errors.Is(err, dataeng.ErrTruncated) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrTruncated)
		}
	})

	t.Run("batch length below header size", func(t *testing.T) {
		bad := batch
		bad.overrideBatchLength = true
		bad.batchLength = 10
		_, err := dataeng.ParseBatch(encodeBatch(bad))
		if !errors.Is(err, dataeng.ErrInvalidBatch) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrInvalidBatch)
		}
	})

	t.Run("batch length beyond input", func(t *testing.T) {
		bad := batch
		bad.overrideBatchLength = true
		bad.batchLength = int32(len(good)-wireBatchLengthOffset) + 5
		_, err := dataeng.ParseBatch(encodeBatch(bad))
		if !errors.Is(err, dataeng.ErrTruncated) {
			t.Fatalf("error = %v, want %v", err, dataeng.ErrTruncated)
		}
	})
}

func TestReadBatches(t *testing.T) {
	first := encodeBatch(newWireBatch(10, 100, 105, 2,
		wireRecord{offsetDelta: 0}, wireRecord{offsetDelta: 2}))
	second := encodeBatch(newWireBatch(20, 200, 200, 0, wireRecord{offsetDelta: 0}))
	data := append(append([]byte{}, first...), second...)

	got, err := dataeng.NewDefaultReader().ReadBatches(data)
	if err != nil {
		t.Fatalf("ReadBatches: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("batch count = %d, want 2", len(got))
	}
	if got[0].Records[0].Offset != 10 || got[0].Records[1].Offset != 12 {
		t.Errorf("first batch offsets = %d,%d, want 10,12",
			got[0].Records[0].Offset, got[0].Records[1].Offset)
	}
	if got[1].Records[0].Offset != 20 {
		t.Errorf("second batch offset = %d, want 20", got[1].Records[0].Offset)
	}
	if got[0].Size != len(first) || got[1].Size != len(second) {
		t.Errorf("batch sizes = %d,%d, want %d,%d",
			got[0].Size, got[1].Size, len(first), len(second))
	}
}

func TestEmptyBatch(t *testing.T) {
	batch := newWireBatch(5, 100, 100, -1)
	got, err := dataeng.ParseBatch(encodeBatch(batch))
	if err != nil {
		t.Fatalf("ParseBatch: %v", err)
	}
	if len(got.Records) != 0 {
		t.Fatalf("record count = %d, want 0", len(got.Records))
	}
}

func TestReaderLimits(t *testing.T) {
	if _, err := dataeng.NewReader(0); err == nil {
		t.Fatal("NewReader(0) succeeded, want an error")
	}

	var zero dataeng.Reader
	if got := zero.MaxRecordBytes(); got != dataeng.DefaultMaxRecordBytes {
		t.Fatalf("zero-value reader limit = %d, want %d", got, dataeng.DefaultMaxRecordBytes)
	}

	reader, err := dataeng.NewReader(123)
	if err != nil {
		t.Fatalf("NewReader: %v", err)
	}
	if got := reader.MaxRecordBytes(); got != 123 {
		t.Fatalf("reader limit = %d, want 123", got)
	}
}
