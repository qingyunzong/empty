package dataeng

import (
	"bytes"
	"crypto/md5"
	"errors"
	"reflect"
	"testing"
)

type testProtoRecord struct {
	partitionKeyIndex    *uint64
	explicitHashKeyIndex *uint64
	data                 []byte
	hasData              bool
}

func TestDeaggregate(t *testing.T) {
	one := uint64(1)
	two := uint64(2)
	payload := testAggregate(t,
		[]string{"pk-a", "pk-b"},
		[]string{"hash-a"},
		[]testProtoRecord{
			{partitionKeyIndex: &one, data: []byte("one"), hasData: true},
			{partitionKeyIndex: &two, explicitHashKeyIndex: &one, data: []byte("two"), hasData: true},
		},
	)

	records, err := Deaggregate(payload, "49590338271490256608559692538361571095921575989136588898")
	if err != nil {
		t.Fatalf("Deaggregate() error = %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("Deaggregate() returned %d records, want 2", len(records))
	}

	want := []Record{
		{
			Data:              []byte("one"),
			PartitionKey:      "pk-a",
			SequenceNumber:    "49590338271490256608559692538361571095921575989136588898",
			SubSequenceNumber: 0,
		},
		{
			Data:              []byte("two"),
			PartitionKey:      "pk-b",
			ExplicitHashKey:   "hash-a",
			SequenceNumber:    "49590338271490256608559692538361571095921575989136588898",
			SubSequenceNumber: 1,
		},
	}
	if !reflect.DeepEqual(records, want) {
		t.Fatalf("Deaggregate() = %#v, want %#v", records, want)
	}
	if !records[1].HasExplicitHashKey() {
		t.Fatal("second record should report an explicit hash key")
	}
	if records[1].ParentSequenceNumber() != records[1].SequenceNumber {
		t.Fatal("ParentSequenceNumber() must preserve the parent sequence")
	}
}

func TestDeaggregateValidation(t *testing.T) {
	one := uint64(1)
	two := uint64(2)
	zero := uint64(0)

	valid := testAggregate(t, []string{"pk"}, nil, []testProtoRecord{
		{partitionKeyIndex: &one, data: []byte("data"), hasData: true},
	})

	tests := []struct {
		name    string
		payload []byte
		wantErr error
	}{
		{
			name:    "not aggregated",
			payload: []byte("not a KPL record"),
			wantErr: ErrNotAggregated,
		},
		{
			name: "bad MD5",
			payload: func() []byte {
				b := bytes.Clone(valid)
				b[len(b)-1] ^= 0xff
				return b
			}(),
			wantErr: ErrMD5Mismatch,
		},
		{
			name:    "truncated digest",
			payload: valid[:MagicSize+MD5Size-1],
			wantErr: ErrTruncated,
		},
		{
			name: "partition index zero",
			payload: testAggregate(t, []string{"pk"}, nil, []testProtoRecord{
				{partitionKeyIndex: &zero, data: []byte("data"), hasData: true},
			}),
			wantErr: ErrInvalidPartitionKeyIndex,
		},
		{
			name: "partition index out of range",
			payload: testAggregate(t, []string{"pk"}, nil, []testProtoRecord{
				{partitionKeyIndex: &two, data: []byte("data"), hasData: true},
			}),
			wantErr: ErrInvalidPartitionKeyIndex,
		},
		{
			name: "missing partition index",
			payload: testAggregate(t, []string{"pk"}, nil, []testProtoRecord{
				{data: []byte("data"), hasData: true},
			}),
			wantErr: ErrInvalidPartitionKeyIndex,
		},
		{
			name: "explicit hash index out of range",
			payload: testAggregate(t, []string{"pk"}, []string{"hash"}, []testProtoRecord{
				{partitionKeyIndex: &one, explicitHashKeyIndex: &two, data: []byte("data"), hasData: true},
			}),
			wantErr: ErrInvalidExplicitHashKeyIndex,
		},
		{
			name: "missing data",
			payload: testAggregate(t, []string{"pk"}, nil, []testProtoRecord{
				{partitionKeyIndex: &one},
			}),
			wantErr: ErrMissingData,
		},
		{
			name:    "invalid protobuf",
			payload: testRawAggregate(t, []byte{0x08}),
			wantErr: ErrMalformedProtobuf,
		},
		{
			name: "invalid UTF-8 table entry",
			payload: testAggregate(t, []string{string([]byte{0xff})}, nil, []testProtoRecord{
				{partitionKeyIndex: &one, data: []byte("data"), hasData: true},
			}),
			wantErr: ErrInvalidUTF8,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			records, err := Deaggregate(tt.payload, "seq")
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("Deaggregate() error = %v, want %v", err, tt.wantErr)
			}
			if records != nil {
				t.Fatalf("Deaggregate() returned partial records on error: %#v", records)
			}
		})
	}
}

func TestDeaggregateExplicitHashKeyIndexZeroIsAbsent(t *testing.T) {
	one := uint64(1)
	zero := uint64(0)
	payload := testAggregate(t, []string{"pk"}, []string{"hash"}, []testProtoRecord{
		{partitionKeyIndex: &one, explicitHashKeyIndex: &zero, data: []byte("data"), hasData: true},
	})

	records, err := Deaggregate(payload)
	if err != nil {
		t.Fatalf("Deaggregate() error = %v", err)
	}
	if len(records) != 1 || records[0].ExplicitHashKey != "" {
		t.Fatalf("Deaggregate() = %#v, want no explicit hash key", records)
	}
}

func TestCheckpointFiltersSubRecords(t *testing.T) {
	one := uint64(1)
	payload := testAggregate(t, []string{"pk"}, nil, []testProtoRecord{
		{partitionKeyIndex: &one, data: []byte("zero"), hasData: true},
		{partitionKeyIndex: &one, data: []byte("one"), hasData: true},
		{partitionKeyIndex: &one, data: []byte("two"), hasData: true},
	})

	records, err := DeaggregateFromCheckpoint(payload, "100", NewCheckpoint("100", 0))
	if err != nil {
		t.Fatalf("DeaggregateFromCheckpoint() error = %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("got %d records after checkpoint, want 2", len(records))
	}
	if records[0].SubSequenceNumber != 1 || records[1].SubSequenceNumber != 2 {
		t.Fatalf("unexpected sub-sequences: %d, %d", records[0].SubSequenceNumber, records[1].SubSequenceNumber)
	}

	records, err = DeaggregateFromCheckpoint(payload, "100", NewCheckpoint("100", 2))
	if err != nil {
		t.Fatalf("DeaggregateFromCheckpoint() error = %v", err)
	}
	if len(records) != 0 {
		t.Fatalf("got %d records after final checkpoint, want 0", len(records))
	}
}

func TestCheckpointComparesSequenceNumbersNumerically(t *testing.T) {
	checkpoint := NewCheckpoint("9", 0)
	if checkpoint.Covers(Record{SequenceNumber: "10"}) {
		t.Fatal("sequence 10 must sort after sequence 9")
	}

	var advanced Checkpoint
	advanced = advanced.Advance(Record{SequenceNumber: "10", SubSequenceNumber: 3})
	if advanced != (Checkpoint{SequenceNumber: "10", SubSequenceNumber: 3}) {
		t.Fatalf("Advance() = %#v", advanced)
	}
	if got := advanced.Advance(Record{SequenceNumber: "10", SubSequenceNumber: 1}); got != advanced {
		t.Fatalf("Advance() moved backwards: %#v", got)
	}
}

func TestDeaggregateBatchIsAtomic(t *testing.T) {
	one := uint64(1)
	good := testAggregate(t, []string{"pk"}, nil, []testProtoRecord{
		{partitionKeyIndex: &one, data: []byte("good"), hasData: true},
	})
	bad := bytes.Clone(good)
	bad[len(bad)-1] ^= 0xff

	records, checkpoint, err := DeaggregateBatch([]RawRecord{
		{SequenceNumber: "20", Data: good},
		{SequenceNumber: "21", Data: bad},
		{SequenceNumber: "22", Data: good},
	})
	if err == nil {
		t.Fatal("DeaggregateBatch() succeeded with a corrupt aggregate")
	}
	if records != nil {
		t.Fatalf("DeaggregateBatch() returned partial records: %#v", records)
	}
	if checkpoint != (Checkpoint{}) {
		t.Fatalf("DeaggregateBatch() returned a checkpoint for a failed batch: %#v", checkpoint)
	}

	records, checkpoint, err = DeaggregateBatch([]RawRecord{
		{SequenceNumber: "20", Data: good},
		{SequenceNumber: "21", Data: good},
	})
	if err != nil {
		t.Fatalf("DeaggregateBatch() error = %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("DeaggregateBatch() returned %d records, want 2", len(records))
	}
	if checkpoint != (Checkpoint{SequenceNumber: "21", SubSequenceNumber: 0}) {
		t.Fatalf("DeaggregateBatch() checkpoint = %#v", checkpoint)
	}
}

func testAggregate(t *testing.T, partitionKeys, explicitHashKeys []string, records []testProtoRecord) []byte {
	t.Helper()
	return testRawAggregate(t, testMarshalAggregate(partitionKeys, explicitHashKeys, records))
}

func testRawAggregate(t *testing.T, protobuf []byte) []byte {
	t.Helper()
	digest := md5.Sum(protobuf)
	out := make([]byte, 0, MagicSize+len(protobuf)+MD5Size)
	out = append(out, Magic...)
	out = append(out, protobuf...)
	out = append(out, digest[:]...)
	return out
}

func testMarshalAggregate(partitionKeys, explicitHashKeys []string, records []testProtoRecord) []byte {
	var out []byte
	for _, value := range partitionKeys {
		out = testAppendBytes(out, 1, []byte(value))
	}
	for _, value := range explicitHashKeys {
		out = testAppendBytes(out, 2, []byte(value))
	}
	for _, record := range records {
		var encoded []byte
		if record.partitionKeyIndex != nil {
			encoded = testAppendVarintField(encoded, 1, *record.partitionKeyIndex)
		}
		if record.explicitHashKeyIndex != nil {
			encoded = testAppendVarintField(encoded, 2, *record.explicitHashKeyIndex)
		}
		if record.hasData {
			encoded = testAppendBytes(encoded, 3, record.data)
		}
		out = testAppendBytes(out, 3, encoded)
	}
	return out
}

func testAppendVarintField(out []byte, field int, value uint64) []byte {
	out = testAppendVarint(out, uint64(field<<3))
	return testAppendVarint(out, value)
}

func testAppendBytes(out []byte, field int, value []byte) []byte {
	out = testAppendVarint(out, uint64(field<<3|2))
	out = testAppendVarint(out, uint64(len(value)))
	return append(out, value...)
}

func testAppendVarint(out []byte, value uint64) []byte {
	for value >= 0x80 {
		out = append(out, byte(value)|0x80)
		value >>= 7
	}
	return append(out, byte(value))
}
