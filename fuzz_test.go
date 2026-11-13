package dataeng_test

import (
	"testing"

	dataeng "example.org/dataeng13/q0036"
)

func FuzzParseBatch(f *testing.F) {
	f.Add(encodeBatch(newWireBatch(10, 100, 100, 2,
		wireRecord{offsetDelta: 0, value: []byte("a")},
		wireRecord{offsetDelta: 2, value: []byte("b")})))
	f.Add(encodeBatch(newWireBatch(10, 100, 100, 1,
		wireRecord{offsetDelta: 0, value: []byte("a")},
		wireRecord{offsetDelta: 1, control: true, marker: 1})))
	f.Add([]byte{0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0})

	f.Fuzz(func(t *testing.T, data []byte) {
		batch, err := dataeng.ParseBatchWithLimit(data, 4096)
		if err != nil {
			return
		}
		for i, record := range batch.Records {
			if record.OffsetDelta < 0 {
				t.Fatalf("record %d has negative offset delta %d", i, record.OffsetDelta)
			}
			if record.Offset != batch.BaseOffset+int64(record.OffsetDelta) {
				t.Fatalf("record %d offset %d does not match base %d + delta %d",
					i, record.Offset, batch.BaseOffset, record.OffsetDelta)
			}
			if record.Timestamp > batch.MaxTimestamp {
				t.Fatalf("record %d timestamp %d exceeds maximum %d",
					i, record.Timestamp, batch.MaxTimestamp)
			}
		}
		if len(batch.Records) > 0 {
			last := batch.Records[len(batch.Records)-1]
			if batch.BaseOffset+int64(batch.LastOffsetDelta) != last.Offset {
				t.Fatalf("base %d + last delta %d != last offset %d",
					batch.BaseOffset, batch.LastOffsetDelta, last.Offset)
			}
		}
	})
}
