package dataeng

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"strconv"
)

// DefaultValue interprets a JSON default value using the reader schema type.
//
// For a union, Avro defines the default against the first branch only. This
// function never scans branches looking for one whose name or shape appears to
// match the value.
func DefaultValue(schema *Schema, raw any) (any, error) {
	return defaultValue(schema, raw)
}

func defaultValue(schema *Schema, raw any) (any, error) {
	return defaultValueAt(schema, raw, 0, make(map[*Schema]bool))
}

func defaultValueAt(schema *Schema, raw any, depth int, expanding map[*Schema]bool) (any, error) {
	if schema == nil {
		return nil, errors.New("nil schema")
	}
	if depth > 10000 {
		return nil, errors.New("default value nesting too deep")
	}
	switch schema.Type {
	case Null:
		if raw != nil {
			return nil, fmt.Errorf("null default must be null, got %T", raw)
		}
		return nil, nil
	case Boolean:
		value, ok := raw.(bool)
		if !ok {
			return nil, fmt.Errorf("boolean default must be a JSON boolean, got %T", raw)
		}
		return value, nil
	case Int:
		value, err := integerDefault(raw, 32)
		if err != nil {
			return nil, err
		}
		return int32(value), nil
	case Long:
		value, err := integerDefault(raw, 64)
		if err != nil {
			return nil, err
		}
		return value, nil
	case Float:
		value, err := floatDefault(raw, 32)
		if err != nil {
			return nil, err
		}
		return float32(value), nil
	case Double:
		value, err := floatDefault(raw, 64)
		if err != nil {
			return nil, err
		}
		return value, nil
	case Bytes:
		return bytesDefault(raw)
	case String:
		value, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("string default must be a JSON string, got %T", raw)
		}
		return value, nil
	case Fixed:
		value, err := bytesDefault(raw)
		if err != nil {
			return nil, err
		}
		if int64(len(value)) != schema.Size {
			return nil, fmt.Errorf("fixed %q default has %d bytes, want %d", schema.FullName, len(value), schema.Size)
		}
		return value, nil
	case Enum:
		value, ok := raw.(string)
		if !ok {
			return nil, fmt.Errorf("enum default must be a JSON string, got %T", raw)
		}
		if !containsString(schema.Symbols, value) {
			return nil, fmt.Errorf("enum %q has no symbol %q", schema.FullName, value)
		}
		return value, nil
	case Array:
		values, ok := raw.([]any)
		if !ok {
			return nil, fmt.Errorf("array default must be a JSON array, got %T", raw)
		}
		out := make([]any, len(values))
		for i, item := range values {
			value, err := defaultValueAt(schema.Items, item, depth+1, expanding)
			if err != nil {
				return nil, fmt.Errorf("array default element %d: %w", i, err)
			}
			out[i] = value
		}
		return out, nil
	case Map:
		values, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("map default must be a JSON object, got %T", raw)
		}
		out := make(map[string]any, len(values))
		for key, item := range values {
			value, err := defaultValueAt(schema.Values, item, depth+1, expanding)
			if err != nil {
				return nil, fmt.Errorf("map default key %q: %w", key, err)
			}
			out[key] = value
		}
		return out, nil
	case Record:
		values, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("record default must be a JSON object, got %T", raw)
		}
		known := make(map[string]*Field, len(schema.Fields))
		for _, field := range schema.Fields {
			known[field.Name] = field
		}
		for key := range values {
			if known[key] == nil {
				return nil, fmt.Errorf("record %q default has unknown field %q", schema.FullName, key)
			}
		}
		out := make(map[string]any, len(schema.Fields))
		for _, field := range schema.Fields {
			if item, ok := values[field.Name]; ok {
				value, err := defaultValueAt(field.Type, item, depth+1, expanding)
				if err != nil {
					return nil, fmt.Errorf("record %q field %q default: %w", schema.FullName, field.Name, err)
				}
				out[field.Name] = value
				continue
			}
			if !field.HasDefault {
				return nil, fmt.Errorf("record %q default is missing field %q", schema.FullName, field.Name)
			}
			if expanding[schema] {
				return nil, fmt.Errorf("record %q default recursively expands itself", schema.FullName)
			}
			expanding[schema] = true
			value, err := defaultValueAt(field.Type, field.Default, depth+1, expanding)
			delete(expanding, schema)
			if err != nil {
				return nil, fmt.Errorf("record %q field %q default: %w", schema.FullName, field.Name, err)
			}
			out[field.Name] = value
		}
		return out, nil
	case Union:
		if len(schema.Branches) == 0 {
			return nil, errors.New("union has no branches")
		}
		// The Avro default always belongs to the first branch. Do not look at
		// other branches, and do not infer a branch from a value's name.
		value, err := defaultValueAt(schema.Branches[0], raw, depth+1, expanding)
		if err != nil {
			return nil, fmt.Errorf("union default must match first branch %s: %w", schema.Branches[0], err)
		}
		return UnionValue{Index: 0, Value: value}, nil
	default:
		return nil, fmt.Errorf("unsupported default schema type %q", schema.Type)
	}
}

func integerDefault(raw any, bits int) (int64, error) {
	text, ok := numberText(raw)
	if !ok {
		return 0, fmt.Errorf("integer default must be a JSON number, got %T", raw)
	}
	return parseIntegerText(text, bits)
}

func parseIntegerText(text string, bits int) (int64, error) {
	value, err := strconv.ParseInt(text, 10, bits)
	if err == nil {
		return value, nil
	}

	// Accept exponent/decimal spellings such as 1e2 when they denote an
	// exact integer. big.Float avoids losing precision for 64-bit values.
	f, _, parseErr := big.ParseFloat(text, 10, 256, big.ToNearestEven)
	if parseErr != nil {
		return 0, fmt.Errorf("invalid integer %q", text)
	}
	i, accuracy := f.Int(nil)
	if accuracy != big.Exact || !i.IsInt64() {
		return 0, fmt.Errorf("%q is not an exact integer", text)
	}
	value = i.Int64()
	if bits == 32 && (value < -1<<31 || value > 1<<31-1) {
		return 0, fmt.Errorf("integer %q is outside int32 range", text)
	}
	return value, nil
}

func floatDefault(raw any, bits int) (float64, error) {
	text, ok := numberText(raw)
	if !ok {
		return 0, fmt.Errorf("floating-point default must be a JSON number, got %T", raw)
	}
	value, err := strconv.ParseFloat(text, bits)
	if err != nil {
		return 0, fmt.Errorf("invalid floating-point default %q: %w", text, err)
	}
	return value, nil
}

func numberText(raw any) (string, bool) {
	switch value := raw.(type) {
	case json.Number:
		return value.String(), true
	case float64:
		return strconv.FormatFloat(value, 'g', -1, 64), true
	case float32:
		return strconv.FormatFloat(float64(value), 'g', -1, 32), true
	case int:
		return strconv.FormatInt(int64(value), 10), true
	case int8:
		return strconv.FormatInt(int64(value), 10), true
	case int16:
		return strconv.FormatInt(int64(value), 10), true
	case int32:
		return strconv.FormatInt(int64(value), 10), true
	case int64:
		return strconv.FormatInt(value, 10), true
	case uint:
		return strconv.FormatUint(uint64(value), 10), true
	case uint8:
		return strconv.FormatUint(uint64(value), 10), true
	case uint16:
		return strconv.FormatUint(uint64(value), 10), true
	case uint32:
		return strconv.FormatUint(uint64(value), 10), true
	case uint64:
		return strconv.FormatUint(value, 10), true
	default:
		return "", false
	}
}

// bytesDefault implements the Avro JSON default rule for bytes and fixed:
// each Unicode code point maps directly to one byte, and must be <= 0xff.
func bytesDefault(raw any) ([]byte, error) {
	switch value := raw.(type) {
	case string:
		out := make([]byte, 0, len(value))
		for _, r := range value {
			if r > 0xff {
				return nil, fmt.Errorf("byte default contains code point U+%04X, want <= U+00FF", r)
			}
			out = append(out, byte(r))
		}
		return out, nil
	case []byte:
		return append([]byte(nil), value...), nil
	default:
		return nil, fmt.Errorf("bytes default must be a JSON string, got %T", raw)
	}
}

func cloneValue(value any) any {
	switch v := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			out[key] = cloneValue(item)
		}
		return out
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			out[i] = cloneValue(item)
		}
		return out
	case []byte:
		return append([]byte(nil), v...)
	case UnionValue:
		v.Value = cloneValue(v.Value)
		return v
	case *UnionValue:
		if v == nil {
			return (*UnionValue)(nil)
		}
		clone := *v
		clone.Value = cloneValue(v.Value)
		return &clone
	default:
		return value
	}
}
