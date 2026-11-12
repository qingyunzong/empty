package fixture

import (
	"encoding/binary"
	"fmt"
)

// Column is one serial type and its body bytes. BuildPayload does not validate
// that Data matches SerialType, which permits deliberate malformed fixtures.
type Column struct {
	SerialType uint64
	Data       []byte
}

// NullColumn returns serial type 0.
func NullColumn() Column {
	return Column{SerialType: 0}
}

// IntegerColumn returns serial type 6 with an 8-byte big-endian int64.
func IntegerColumn(value int64) Column {
	data := make([]byte, 8)
	binary.BigEndian.PutUint64(data, uint64(value))
	return Column{SerialType: 6, Data: data}
}

// BlobColumn returns an even blob serial type and the corresponding bytes.
func BlobColumn(value []byte) Column {
	return Column{
		SerialType: 12 + 2*uint64(len(value)),
		Data:       append([]byte(nil), value...),
	}
}

// BuiltPayload is a complete logical record payload reference.
type BuiltPayload struct {
	Bytes       []byte
	HeaderSize  uint64
	DataOffsets []uint64
}

// BuildPayload assembles a header containing H and one serial-type varint per
// column, followed by the concatenated Data fields. It intentionally performs
// only structural assembly, not record validation.
func BuildPayload(columns []Column) (*BuiltPayload, error) {
	serialBytes := make([]byte, 0, len(columns))
	for i, column := range columns {
		encoded, err := EncodeVarint(column.SerialType, 0)
		if err != nil {
			return nil, fmt.Errorf("fixture: column %d serial type: %w", i, err)
		}
		serialBytes = append(serialBytes, encoded...)
	}

	headerSize := uint64(1)
	for {
		prefix, err := EncodeVarint(headerSize, 0)
		if err != nil {
			return nil, fmt.Errorf("fixture: header size: %w", err)
		}
		next := uint64(len(prefix)) + uint64(len(serialBytes))
		if next == headerSize {
			break
		}
		headerSize = next
	}
	prefix, err := EncodeVarint(headerSize, 0)
	if err != nil {
		return nil, fmt.Errorf("fixture: header size: %w", err)
	}
	if uint64(len(prefix))+uint64(len(serialBytes)) != headerSize {
		return nil, fmt.Errorf("fixture: header size did not converge")
	}

	bodyLength := 0
	for _, column := range columns {
		bodyLength += len(column.Data)
	}
	pLength := int(headerSize) + bodyLength
	payload := make([]byte, 0, pLength)
	payload = append(payload, prefix...)
	payload = append(payload, serialBytes...)

	offsets := make([]uint64, len(columns))
	cursor := headerSize
	for i, column := range columns {
		offsets[i] = cursor
		payload = append(payload, column.Data...)
		cursor += uint64(len(column.Data))
	}
	return &BuiltPayload{
		Bytes:       payload,
		HeaderSize:  headerSize,
		DataOffsets: offsets,
	}, nil
}
