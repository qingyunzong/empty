package dataeng

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math"
	"strings"
)

// MySQL binary JSON type tags. These are the tags used by the JSON column
// storage format and by the MySQL partial-JSON diff payload.
const (
	jsonbSmallObject = 0x00
	jsonbLargeObject = 0x01
	jsonbSmallArray  = 0x02
	jsonbLargeArray  = 0x03
	jsonbLiteral     = 0x04
	jsonbInt16       = 0x05
	jsonbUint16      = 0x06
	jsonbInt32       = 0x07
	jsonbUint32      = 0x08
	jsonbInt64       = 0x09
	jsonbUint64      = 0x0a
	jsonbDouble      = 0x0b
	jsonbString      = 0x0c
	jsonbOpaque      = 0x0f
)

const (
	jsonDiffReplace = 0x00
	jsonDiffInsert  = 0x01
	jsonDiffRemove  = 0x02
)

// ErrMySQLJSON is returned for malformed MySQL binary JSON or partial-JSON
// diff payloads.
var ErrMySQLJSON = errors.New("dataeng: invalid mysql binary json")

// DecodeMySQLBinaryJSON decodes the binary JSON representation used inside
// MySQL JSON columns. It supports objects, arrays and scalar values.
func DecodeMySQLBinaryJSON(data []byte) (any, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("%w: empty value", ErrMySQLJSON)
	}
	return parseMySQLJSONValue(data[0], data[1:])
}

// DecodeMySQLJSONDiff decodes the MySQL binary partial-JSON diff found in a
// MINIMAL row image. Each operation uses a 1-byte type and a little-endian
// 2-byte path length, followed by the optional binary-JSON value.
func DecodeMySQLJSONDiff(data []byte) (JSONDiff, error) {
	if len(data) == 0 {
		return JSONDiff{}, fmt.Errorf("%w: empty diff", ErrMySQLJSON)
	}
	diff, littleErr := decodeMySQLJSONDiffOrder(data, binary.LittleEndian)
	if littleErr == nil {
		return diff, nil
	}
	diff, bigErr := decodeMySQLJSONDiffOrder(data, binary.BigEndian)
	if bigErr == nil {
		return diff, nil
	}
	return JSONDiff{}, littleErr
}

func decodeMySQLJSONDiffOrder(data []byte, order binary.ByteOrder) (JSONDiff, error) {
	var ops []JSONOperation
	pos := 0
	for pos < len(data) {
		if len(data)-pos < 3 {
			return JSONDiff{}, fmt.Errorf("%w: truncated operation at byte %d", ErrMySQLJSON, pos)
		}
		opType := data[pos]
		pos++
		if opType > jsonDiffRemove {
			return JSONDiff{}, fmt.Errorf("%w: unknown diff operation %#x", ErrMySQLJSON, opType)
		}
		pathLen := int(order.Uint16(data[pos : pos+2]))
		pos += 2
		if pathLen < 0 || pathLen > len(data)-pos {
			return JSONDiff{}, fmt.Errorf("%w: path length %d exceeds payload", ErrMySQLJSON, pathLen)
		}
		path := string(data[pos : pos+pathLen])
		pos += pathLen
		path = mysqlDiffPath(path)

		operation := JSONOperation{Path: path}
		switch opType {
		case jsonDiffReplace:
			operation.Op = "replace"
		case jsonDiffInsert:
			operation.Op = "insert"
		case jsonDiffRemove:
			operation.Op = "remove"
			ops = append(ops, operation)
			continue
		}

		if len(data)-pos < 2 {
			return JSONDiff{}, fmt.Errorf("%w: truncated value length at byte %d", ErrMySQLJSON, pos)
		}
		valueLen := int(order.Uint16(data[pos : pos+2]))
		pos += 2
		if valueLen > len(data)-pos {
			return JSONDiff{}, fmt.Errorf("%w: value length %d exceeds payload", ErrMySQLJSON, valueLen)
		}
		value, err := DecodeMySQLBinaryJSON(data[pos : pos+valueLen])
		if err != nil {
			return JSONDiff{}, err
		}
		pos += valueLen
		operation.Value = value
		ops = append(ops, operation)
	}
	return JSONDiff{Operations: ops}, nil
}

func mysqlDiffPath(path string) string {
	path = strings.TrimSpace(path)
	if path == "" {
		return "$"
	}
	if strings.HasPrefix(path, "$") {
		return path
	}
	if strings.HasPrefix(path, ".") || strings.HasPrefix(path, "[") {
		return "$" + path
	}
	return "$." + path
}

func parseMySQLJSONValue(typ byte, payload []byte) (any, error) {
	switch typ {
	case jsonbSmallObject:
		return parseMySQLObject(payload, false)
	case jsonbLargeObject:
		return parseMySQLObject(payload, true)
	case jsonbSmallArray:
		return parseMySQLArray(payload, false)
	case jsonbLargeArray:
		return parseMySQLArray(payload, true)
	case jsonbLiteral:
		return parseMySQLLiteral(payload)
	case jsonbInt16:
		if len(payload) < 2 {
			return nil, truncated("int16")
		}
		return int64(int16(binary.LittleEndian.Uint16(payload[:2]))), nil
	case jsonbUint16:
		if len(payload) < 2 {
			return nil, truncated("uint16")
		}
		return uint64(binary.LittleEndian.Uint16(payload[:2])), nil
	case jsonbInt32:
		if len(payload) < 4 {
			return nil, truncated("int32")
		}
		return int64(int32(binary.LittleEndian.Uint32(payload[:4]))), nil
	case jsonbUint32:
		if len(payload) < 4 {
			return nil, truncated("uint32")
		}
		return uint64(binary.LittleEndian.Uint32(payload[:4])), nil
	case jsonbInt64:
		if len(payload) < 8 {
			return nil, truncated("int64")
		}
		return int64(binary.LittleEndian.Uint64(payload[:8])), nil
	case jsonbUint64:
		if len(payload) < 8 {
			return nil, truncated("uint64")
		}
		return binary.LittleEndian.Uint64(payload[:8]), nil
	case jsonbDouble:
		if len(payload) < 8 {
			return nil, truncated("double")
		}
		return math.Float64frombits(binary.LittleEndian.Uint64(payload[:8])), nil
	case jsonbString:
		length, pos, err := readMySQLVarint(payload, 0)
		if err != nil {
			return nil, err
		}
		if pos+int(length) > len(payload) {
			return nil, fmt.Errorf("%w: string length exceeds payload", ErrMySQLJSON)
		}
		return string(payload[pos : pos+int(length)]), nil
	case jsonbOpaque:
		if len(payload) < 1 {
			return nil, truncated("opaque")
		}
		length, pos, err := readMySQLVarint(payload, 1)
		if err != nil {
			return nil, err
		}
		if pos+int(length) > len(payload) {
			return nil, fmt.Errorf("%w: opaque length exceeds payload", ErrMySQLJSON)
		}
		return MySQLOpaque{Type: payload[0], Data: append([]byte(nil), payload[pos:pos+int(length)]...)}, nil
	default:
		return nil, fmt.Errorf("%w: unknown type tag %#x", ErrMySQLJSON, typ)
	}
}

// MySQLOpaque is the decoded form of a MySQL binary JSON opaque value (for
// example DECIMAL, DATE and TIME values embedded in JSON).
type MySQLOpaque struct {
	Type byte
	Data []byte
}

func parseMySQLLiteral(payload []byte) (any, error) {
	if len(payload) < 1 {
		return nil, truncated("literal")
	}
	switch payload[0] {
	case 0:
		return nil, nil
	case 1:
		return true, nil
	case 2:
		return false, nil
	default:
		return nil, fmt.Errorf("%w: unknown literal %d", ErrMySQLJSON, payload[0])
	}
}

func parseMySQLObject(payload []byte, large bool) (any, error) {
	headerSize := 4
	keyEntrySize := 4
	valueEntrySize := 3
	if large {
		headerSize = 8
		keyEntrySize = 6
		valueEntrySize = 5
	}
	if len(payload) < headerSize {
		return nil, truncated("object header")
	}

	var count int
	if large {
		count = int(binary.LittleEndian.Uint32(payload[:4]))
	} else {
		count = int(binary.LittleEndian.Uint16(payload[:2]))
	}
	if count < 0 {
		return nil, fmt.Errorf("%w: negative object count", ErrMySQLJSON)
	}

	keyEntries := headerSize
	valueEntries := keyEntries + count*keyEntrySize
	need := valueEntries + count*valueEntrySize
	if need > len(payload) {
		return nil, fmt.Errorf("%w: object entries exceed payload", ErrMySQLJSON)
	}

	result := make(map[string]any, count)
	for i := 0; i < count; i++ {
		entry := payload[keyEntries+i*keyEntrySize:]
		var keyOffset int
		var keyLength int
		if large {
			keyOffset = int(binary.LittleEndian.Uint32(entry[:4]))
			keyLength = int(binary.LittleEndian.Uint16(entry[4:6]))
		} else {
			keyOffset = int(binary.LittleEndian.Uint16(entry[:2]))
			keyLength = int(binary.LittleEndian.Uint16(entry[2:4]))
		}
		if keyOffset < 0 || keyLength < 0 || keyOffset+keyLength > len(payload) {
			return nil, fmt.Errorf("%w: object key %d exceeds payload", ErrMySQLJSON, i)
		}
		key := string(payload[keyOffset : keyOffset+keyLength])

		valueEntry := payload[valueEntries+i*valueEntrySize:]
		valueType := valueEntry[0]
		var field int
		if large {
			field = int(binary.LittleEndian.Uint32(valueEntry[1:5]))
		} else {
			field = int(binary.LittleEndian.Uint16(valueEntry[1:3]))
		}
		value, err := parseMySQLContainerValue(valueType, field, payload, large)
		if err != nil {
			return nil, fmt.Errorf("%w: object value %q: %v", ErrMySQLJSON, key, err)
		}
		result[key] = value
	}
	return result, nil
}

func parseMySQLArray(payload []byte, large bool) (any, error) {
	headerSize := 4
	entrySize := 3
	if large {
		headerSize = 8
		entrySize = 5
	}
	if len(payload) < headerSize {
		return nil, truncated("array header")
	}
	var count int
	if large {
		count = int(binary.LittleEndian.Uint32(payload[:4]))
	} else {
		count = int(binary.LittleEndian.Uint16(payload[:2]))
	}
	if count < 0 || headerSize+count*entrySize > len(payload) {
		return nil, fmt.Errorf("%w: array entries exceed payload", ErrMySQLJSON)
	}

	result := make([]any, count)
	for i := 0; i < count; i++ {
		entry := payload[headerSize+i*entrySize:]
		valueType := entry[0]
		var field int
		if large {
			field = int(binary.LittleEndian.Uint32(entry[1:5]))
		} else {
			field = int(binary.LittleEndian.Uint16(entry[1:3]))
		}
		value, err := parseMySQLContainerValue(valueType, field, payload, large)
		if err != nil {
			return nil, fmt.Errorf("%w: array value %d: %v", ErrMySQLJSON, i, err)
		}
		result[i] = value
	}
	return result, nil
}

func parseMySQLContainerValue(typ byte, field int, container []byte, large bool) (any, error) {
	switch typ {
	case jsonbLiteral:
		// The low byte of the entry field holds the literal value.
		return parseMySQLLiteral([]byte{byte(field & 0xff)})
	case jsonbInt16:
		return int64(int16(uint16(field))), nil
	case jsonbUint16:
		return uint64(uint16(field)), nil
	case jsonbInt32, jsonbUint32, jsonbInt64, jsonbUint64, jsonbDouble, jsonbString, jsonbOpaque,
		jsonbSmallObject, jsonbLargeObject, jsonbSmallArray, jsonbLargeArray:
		if field < 0 || field > len(container) {
			return nil, fmt.Errorf("%w: value offset %d exceeds payload", ErrMySQLJSON, field)
		}
		return parseMySQLJSONValue(typ, container[field:])
	default:
		return nil, fmt.Errorf("%w: unknown value type %#x", ErrMySQLJSON, typ)
	}
}

func readMySQLVarint(data []byte, pos int) (uint64, int, error) {
	var value uint64
	for i := 0; i < 5; i++ {
		if pos+i >= len(data) {
			return 0, 0, fmt.Errorf("%w: truncated variable length", ErrMySQLJSON)
		}
		current := data[pos+i]
		value = (value << 7) | uint64(current&0x7f)
		if current&0x80 == 0 {
			return value, pos + i + 1, nil
		}
	}
	return 0, 0, fmt.Errorf("%w: variable length is too large", ErrMySQLJSON)
}

func truncated(what string) error {
	return fmt.Errorf("%w: truncated %s", ErrMySQLJSON, what)
}
