package dataeng

import (
	"bytes"
	"crypto/md5"
	"crypto/subtle"
	"errors"
	"fmt"
	"unicode/utf8"
)

const (
	// MagicSize is the size of the KPL aggregate magic prefix.
	MagicSize = 4

	// MD5Size is the size of the digest stored at the end of a KPL aggregate.
	MD5Size = md5.Size

	// HeaderSize is the number of bytes before the protobuf payload.
	HeaderSize = MagicSize
)

// Magic is the four-byte prefix used by the Kinesis Producer Library for
// aggregated records.
var Magic = []byte{0xf3, 0x89, 0x9a, 0xc2}

var (
	// ErrInvalidAggregate is the umbrella error returned for malformed KPL
	// aggregate payloads.
	ErrInvalidAggregate = errors.New("dataeng: invalid KPL aggregate")

	// ErrNotAggregated is returned when a payload does not start with the
	// KPL aggregate magic.
	ErrNotAggregated = errors.New("dataeng: record is not a KPL aggregate")

	// ErrMagicMismatch is returned for an invalid KPL magic prefix.
	ErrMagicMismatch = fmt.Errorf("%w: %w", ErrInvalidAggregate, ErrNotAggregated)

	// ErrTruncated is returned when an aggregate or protobuf field ends in
	// the middle of a value.
	ErrTruncated = fmt.Errorf("%w: truncated payload", ErrInvalidAggregate)

	// ErrMD5Mismatch is returned when the trailing digest does not match the
	// protobuf payload.
	ErrMD5Mismatch = fmt.Errorf("%w: MD5 digest mismatch", ErrInvalidAggregate)

	// ErrMalformedProtobuf is returned for invalid protobuf wire data.
	ErrMalformedProtobuf = fmt.Errorf("%w: malformed protobuf payload", ErrInvalidAggregate)

	// ErrInvalidPartitionKeyIndex is returned when a record refers to a
	// partition key table entry that does not exist.
	ErrInvalidPartitionKeyIndex = fmt.Errorf("%w: invalid partition key index", ErrInvalidAggregate)

	// ErrInvalidExplicitHashKeyIndex is returned when a record refers to an
	// explicit hash key table entry that does not exist.
	ErrInvalidExplicitHashKeyIndex = fmt.Errorf("%w: invalid explicit hash key index", ErrInvalidAggregate)

	// ErrMissingPartitionKeyIndex is returned when a protobuf record omits
	// its required partition key index.
	ErrMissingPartitionKeyIndex = fmt.Errorf("%w: missing partition key index", ErrInvalidAggregate)

	// ErrMissingData is returned when a protobuf record omits its required
	// data field.
	ErrMissingData = fmt.Errorf("%w: missing record data", ErrInvalidAggregate)

	// ErrInvalidUTF8 is returned when a protobuf string field is not valid
	// UTF-8. Protobuf string fields are required to be valid UTF-8.
	ErrInvalidUTF8 = fmt.Errorf("%w: string is not valid UTF-8", ErrMalformedProtobuf)

	// Common short aliases used by callers that only care about the reason
	// class.
	ErrBadMagic               = ErrMagicMismatch
	ErrInvalidMagic           = ErrMagicMismatch
	ErrBadMD5                 = ErrMD5Mismatch
	ErrInvalidMD5             = ErrMD5Mismatch
	ErrInvalidPartitionKey    = ErrInvalidPartitionKeyIndex
	ErrInvalidExplicitHashKey = ErrInvalidExplicitHashKeyIndex
	ErrMalformedAggregate     = ErrMalformedProtobuf
)

// Deaggregate validates and unpacks a KPL aggregated Kinesis record.
//
// The optional parent sequence number is attached to every recovered record.
// SubSequenceNumber is assigned by position, starting at zero.
//
// The function is atomic: it returns either a complete, validated slice of
// records or an error with no partial result. A caller must therefore not
// acknowledge any child of a record for which Deaggregate returns an error.
func Deaggregate(data []byte, parentSequenceNumber ...string) ([]Record, error) {
	sequenceNumber := ""
	if len(parentSequenceNumber) > 0 {
		sequenceNumber = parentSequenceNumber[0]
	}

	payload, err := validateAggregate(data)
	if err != nil {
		return nil, err
	}

	aggregate, err := parseAggregatedRecord(payload)
	if err != nil {
		return nil, err
	}

	records, err := aggregate.records(sequenceNumber)
	if err != nil {
		return nil, err
	}
	return records, nil
}

// DeaggregateWithSequence is the explicit form of Deaggregate for callers
// that always have the parent Kinesis sequence number available.
func DeaggregateWithSequence(data []byte, sequenceNumber string) ([]Record, error) {
	return Deaggregate(data, sequenceNumber)
}

// DeaggregateRecord is an alias for Deaggregate.
func DeaggregateRecord(data []byte, parentSequenceNumber ...string) ([]Record, error) {
	return Deaggregate(data, parentSequenceNumber...)
}

// UnpackAggregatedRecord is an alias for Deaggregate.
func UnpackAggregatedRecord(data []byte, parentSequenceNumber ...string) ([]Record, error) {
	return Deaggregate(data, parentSequenceNumber...)
}

// DecodeAggregatedRecord is an alias for Deaggregate.
func DecodeAggregatedRecord(data []byte, parentSequenceNumber ...string) ([]Record, error) {
	return Deaggregate(data, parentSequenceNumber...)
}

// Unpack is an alias for Deaggregate.
func Unpack(data []byte, parentSequenceNumber ...string) ([]Record, error) {
	return Deaggregate(data, parentSequenceNumber...)
}

// Decode is an alias for Deaggregate.
func Decode(data []byte, parentSequenceNumber ...string) ([]Record, error) {
	return Deaggregate(data, parentSequenceNumber...)
}

// IsAggregated reports whether data starts with the KPL aggregate magic. It
// does not validate the digest or protobuf body.
func IsAggregated(data []byte) bool {
	return len(data) >= MagicSize && bytes.Equal(data[:MagicSize], Magic)
}

func validateAggregate(data []byte) ([]byte, error) {
	if len(data) < MagicSize+MD5Size {
		if len(data) < MagicSize || !bytes.Equal(data[:min(len(data), MagicSize)], Magic[:min(len(data), MagicSize)]) {
			return nil, ErrMagicMismatch
		}
		return nil, ErrTruncated
	}
	if !bytes.Equal(data[:MagicSize], Magic) {
		return nil, ErrMagicMismatch
	}

	payload := data[MagicSize : len(data)-MD5Size]
	want := data[len(data)-MD5Size:]
	sum := md5.Sum(payload)
	if subtle.ConstantTimeCompare(sum[:], want) != 1 {
		return nil, ErrMD5Mismatch
	}
	return payload, nil
}

type aggregatedRecord struct {
	partitionKeys    []string
	explicitHashKeys []string
	recordsData      []protobufRecord
}

type protobufRecord struct {
	partitionKeyIndex       uint64
	hasPartitionKeyIndex    bool
	explicitHashKeyIndex    uint64
	hasExplicitHashKeyIndex bool
	data                    []byte
	hasData                 bool
}

func (a *aggregatedRecord) records(sequenceNumber string) ([]Record, error) {
	records := make([]Record, 0, len(a.recordsData))
	for i, raw := range a.recordsData {
		if !raw.hasPartitionKeyIndex || raw.partitionKeyIndex == 0 ||
			raw.partitionKeyIndex > uint64(len(a.partitionKeys)) {
			return nil, fmt.Errorf("%w: record %d has index %d (table size %d)",
				ErrInvalidPartitionKeyIndex, i, raw.partitionKeyIndex, len(a.partitionKeys))
		}
		if !raw.hasData {
			return nil, fmt.Errorf("%w: record %d", ErrMissingData, i)
		}

		var explicitHashKey string
		if raw.hasExplicitHashKeyIndex && raw.explicitHashKeyIndex != 0 {
			if raw.explicitHashKeyIndex > uint64(len(a.explicitHashKeys)) {
				return nil, fmt.Errorf("%w: record %d has index %d (table size %d)",
					ErrInvalidExplicitHashKeyIndex, i, raw.explicitHashKeyIndex, len(a.explicitHashKeys))
			}
			explicitHashKey = a.explicitHashKeys[raw.explicitHashKeyIndex-1]
		}

		recordData := make([]byte, len(raw.data))
		copy(recordData, raw.data)
		records = append(records, Record{
			Data:              recordData,
			PartitionKey:      a.partitionKeys[raw.partitionKeyIndex-1],
			ExplicitHashKey:   explicitHashKey,
			SequenceNumber:    sequenceNumber,
			SubSequenceNumber: i,
		})
	}
	return records, nil
}

func parseAggregatedRecord(payload []byte) (*aggregatedRecord, error) {
	result := &aggregatedRecord{}

	for len(payload) > 0 {
		key, n, err := readVarint(payload)
		if err != nil {
			return nil, err
		}
		payload = payload[n:]

		fieldNumber := key >> 3
		wireType := int(key & 0x7)
		if fieldNumber == 0 {
			return nil, fmt.Errorf("%w: field number zero", ErrMalformedProtobuf)
		}

		switch fieldNumber {
		case 1, 2:
			if wireType != 2 {
				return nil, fmt.Errorf("%w: field %d has wire type %d",
					ErrMalformedProtobuf, fieldNumber, wireType)
			}
			value, rest, err := readBytes(payload)
			if err != nil {
				return nil, err
			}
			if !utf8.Valid(value) {
				return nil, fmt.Errorf("%w: field %d", ErrInvalidUTF8, fieldNumber)
			}
			if fieldNumber == 1 {
				result.partitionKeys = append(result.partitionKeys, string(value))
			} else {
				result.explicitHashKeys = append(result.explicitHashKeys, string(value))
			}
			payload = rest

		case 3:
			if wireType != 2 {
				return nil, fmt.Errorf("%w: field 3 has wire type %d",
					ErrMalformedProtobuf, wireType)
			}
			value, rest, err := readBytes(payload)
			if err != nil {
				return nil, err
			}
			record, err := parseRecord(value)
			if err != nil {
				return nil, err
			}
			result.recordsData = append(result.recordsData, record)
			payload = rest

		default:
			rest, err := skipField(payload, wireType)
			if err != nil {
				return nil, err
			}
			payload = rest
		}
	}

	return result, nil
}

func parseRecord(payload []byte) (protobufRecord, error) {
	var record protobufRecord

	for len(payload) > 0 {
		key, n, err := readVarint(payload)
		if err != nil {
			return record, err
		}
		payload = payload[n:]

		fieldNumber := key >> 3
		wireType := int(key & 0x7)
		if fieldNumber == 0 {
			return record, fmt.Errorf("%w: field number zero", ErrMalformedProtobuf)
		}

		switch fieldNumber {
		case 1, 2:
			if wireType != 0 {
				return record, fmt.Errorf("%w: record field %d has wire type %d",
					ErrMalformedProtobuf, fieldNumber, wireType)
			}
			value, used, err := readVarint(payload)
			if err != nil {
				return record, err
			}
			payload = payload[used:]
			if fieldNumber == 1 {
				record.partitionKeyIndex = value
				record.hasPartitionKeyIndex = true
			} else {
				record.explicitHashKeyIndex = value
				record.hasExplicitHashKeyIndex = true
			}

		case 3:
			if wireType != 2 {
				return record, fmt.Errorf("%w: record field 3 has wire type %d",
					ErrMalformedProtobuf, wireType)
			}
			value, rest, err := readBytes(payload)
			if err != nil {
				return record, err
			}
			record.data = append(record.data[:0], value...)
			record.hasData = true
			payload = rest

		default:
			rest, err := skipField(payload, wireType)
			if err != nil {
				return record, err
			}
			payload = rest
		}
	}

	return record, nil
}

func readVarint(data []byte) (uint64, int, error) {
	var value uint64
	for i := 0; i < len(data) && i < 10; i++ {
		b := data[i]
		if i == 9 && b > 1 {
			return 0, 0, fmt.Errorf("%w: varint overflow", ErrMalformedProtobuf)
		}
		value |= uint64(b&0x7f) << (7 * i)
		if b < 0x80 {
			return value, i + 1, nil
		}
	}
	if len(data) >= 10 {
		return 0, 0, fmt.Errorf("%w: varint overflow", ErrMalformedProtobuf)
	}
	return 0, 0, ErrTruncated
}

func readBytes(data []byte) ([]byte, []byte, error) {
	length, n, err := readVarint(data)
	if err != nil {
		return nil, nil, err
	}
	data = data[n:]
	if length > uint64(len(data)) {
		return nil, nil, ErrTruncated
	}
	return data[:int(length)], data[int(length):], nil
}

func skipField(data []byte, wireType int) ([]byte, error) {
	switch wireType {
	case 0:
		_, n, err := readVarint(data)
		if err != nil {
			return nil, err
		}
		return data[n:], nil
	case 1:
		if len(data) < 8 {
			return nil, ErrTruncated
		}
		return data[8:], nil
	case 2:
		_, rest, err := readBytes(data)
		return rest, err
	case 5:
		if len(data) < 4 {
			return nil, ErrTruncated
		}
		return data[4:], nil
	default:
		return nil, fmt.Errorf("%w: unsupported wire type %d", ErrMalformedProtobuf, wireType)
	}
}
