package formal

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"time"
)

const (
	recordVersion   = 1
	frameHeaderSize = 8
	maxRecordSize   = 64 << 20
)

var castagnoli = crc32.MakeTable(crc32.Castagnoli)

type recordKind string

const (
	recordPrepare  recordKind = "prepare"
	recordCommit   recordKind = "commit"
	recordRollback recordKind = "rollback"
	recordCheck    recordKind = "check"
)

// record is deliberately small and self-describing. A final decision is never
// written twice by the coordinator, but replay still deduplicates it by Ref so
// that an ambiguous append or an externally copied record cannot duplicate a
// delivery.
type record struct {
	Version  int        `json:"v"`
	Kind     recordKind `json:"kind"`
	Ref      Ref        `json:"ref"`
	At       jsonTime   `json:"at"`
	Message  *Message   `json:"message,omitempty"`
	Deadline jsonTime   `json:"deadline,omitempty"`
	Reason   string     `json:"reason,omitempty"`
}

// jsonTime keeps the record format stable and strips monotonic clock data.
type jsonTime struct {
	time.Time
}

func (t jsonTime) MarshalJSON() ([]byte, error) {
	if t.Time.IsZero() {
		return []byte("null"), nil
	}
	return t.Time.UTC().MarshalJSON()
}

func (t *jsonTime) UnmarshalJSON(data []byte) error {
	if string(data) == "null" {
		t.Time = time.Time{}
		return nil
	}
	return t.Time.UnmarshalJSON(data)
}

func encodeFrame(rec record) ([]byte, error) {
	payload, err := json.Marshal(rec)
	if err != nil {
		return nil, fmt.Errorf("formal: encode transaction record: %w", err)
	}
	if len(payload) > maxRecordSize {
		return nil, fmt.Errorf("%w: %d bytes", ErrRecordTooLarge, len(payload))
	}
	frame := make([]byte, frameHeaderSize+len(payload))
	binary.BigEndian.PutUint32(frame[0:4], uint32(len(payload)))
	binary.BigEndian.PutUint32(frame[4:8], crc32.Checksum(payload, castagnoli))
	copy(frame[frameHeaderSize:], payload)
	return frame, nil
}

func decodeRecord(payload []byte) (record, error) {
	var rec record
	if err := json.Unmarshal(payload, &rec); err != nil {
		return record{}, fmt.Errorf("formal: decode transaction record: %w", err)
	}
	if rec.Version != recordVersion {
		return record{}, fmt.Errorf("formal: unsupported transaction record version %d", rec.Version)
	}
	return rec, nil
}

type journal struct {
	payloads [][]byte
	bounds   [][2]int
	valid    int
	tail     int
}

// parseJournal returns every complete, checksummed frame and the offset of the
// first incomplete tail. An append-only log can only be torn at its end, so a
// complete frame with a bad checksum is a hard error rather than silently
// discarded data.
func parseJournal(data []byte) (journal, error) {
	var out journal
	offset := 0
	for offset < len(data) {
		if len(data)-offset < frameHeaderSize {
			out.valid = offset
			out.tail = len(data) - offset
			return out, nil
		}
		length := binary.BigEndian.Uint32(data[offset : offset+4])
		if length == 0 || length > maxRecordSize {
			return out, fmt.Errorf("%w: invalid frame length %d at offset %d", ErrCorruptLog, length, offset)
		}
		end := offset + frameHeaderSize + int(length)
		if end > len(data) {
			out.valid = offset
			out.tail = len(data) - offset
			return out, nil
		}
		want := binary.BigEndian.Uint32(data[offset+4 : offset+8])
		got := crc32.Checksum(data[offset+frameHeaderSize:end], castagnoli)
		if want != got {
			return out, fmt.Errorf("%w: checksum mismatch at offset %d", ErrCorruptLog, offset)
		}
		out.payloads = append(out.payloads, data[offset+frameHeaderSize:end])
		out.bounds = append(out.bounds, [2]int{offset, end})
		offset = end
	}
	out.valid = offset
	return out, nil
}
