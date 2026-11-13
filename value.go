package dataeng

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"strconv"
	"strings"
)

// UnionValue is the explicit representation of an Avro union datum. Index
// identifies the writer or reader union branch; Value is the branch datum.
// Resolving a writer union requires this wrapper because branch identity
// cannot be recovered reliably from a bare Go value.
type UnionValue struct {
	Index int
	Value any
}

// NewUnionValue constructs an explicitly tagged union value.
func NewUnionValue(index int, value any) UnionValue {
	return UnionValue{Index: index, Value: value}
}

// Unwrap returns the branch datum.
func (u UnionValue) Unwrap() any { return u.Value }

// ResolveJSON decodes one JSON datum and resolves it from writer to reader.
// Numbers are decoded with json.Number so 64-bit integers retain precision.
func ResolveJSON(writer, reader *Schema, message []byte) (any, error) {
	resolver, err := NewResolver(writer, reader)
	if err != nil {
		return nil, err
	}
	return resolver.ResolveJSON(message)
}

// ResolveJSON decodes one JSON datum and resolves it with this resolver.
func (r *Resolver) ResolveJSON(message []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(message))
	dec.UseNumber()
	var datum any
	if err := dec.Decode(&datum); err != nil {
		return nil, fmt.Errorf("avro: decode message: %w", err)
	}
	var trailing any
	if err := dec.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, errors.New("avro: trailing data after message")
		}
		return nil, fmt.Errorf("avro: decode message: %w", err)
	}
	return r.Resolve(datum)
}

func resolveValue(res *Resolution, value any) (any, error) {
	if res == nil || res.Writer == nil || res.Reader == nil {
		return nil, errors.New("avro: nil resolution")
	}
	if res.Union != nil {
		return resolveUnion(res.Union, value)
	}
	if res.Promotion != NoPromotion {
		return promoteValue(res, value)
	}

	writer, reader := res.Writer, res.Reader
	if writer.Type != reader.Type {
		return nil, fmt.Errorf("internal resolution error: %s -> %s", writer.Type, reader.Type)
	}

	switch reader.Type {
	case Null:
		if value != nil {
			return nil, fmt.Errorf("expected null, got %T", value)
		}
		return nil, nil
	case Boolean:
		value, ok := value.(bool)
		if !ok {
			return nil, fmt.Errorf("expected boolean, got %T", value)
		}
		return value, nil
	case Int:
		value, err := int32Value(value)
		if err != nil {
			return nil, err
		}
		return value, nil
	case Long:
		value, err := int64Value(value)
		if err != nil {
			return nil, err
		}
		return value, nil
	case Float:
		value, err := float32Value(value)
		if err != nil {
			return nil, err
		}
		return value, nil
	case Double:
		value, err := float64Value(value)
		if err != nil {
			return nil, err
		}
		return value, nil
	case Bytes:
		return bytesValue(value)
	case String:
		value, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("expected string, got %T", value)
		}
		return value, nil
	case Fixed:
		value, err := bytesValue(value)
		if err != nil {
			return nil, err
		}
		if int64(len(value)) != reader.Size {
			return nil, fmt.Errorf("expected %d fixed bytes, got %d", reader.Size, len(value))
		}
		return value, nil
	case Enum:
		symbol, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("expected enum symbol string, got %T", value)
		}
		if !containsString(writer.Symbols, symbol) {
			return nil, fmt.Errorf("symbol %q is not in writer enum %q", symbol, writer.FullName)
		}
		if containsString(reader.Symbols, symbol) {
			return symbol, nil
		}
		if reader.HasEnumDefault {
			return reader.EnumDefault, nil
		}
		return nil, fmt.Errorf("symbol %q is not in reader enum %q", symbol, reader.FullName)
	case Record:
		return resolveRecord(res, value)
	case Array:
		return resolveArray(res, value)
	case Map:
		return resolveMap(res, value)
	default:
		return nil, fmt.Errorf("unsupported schema type %q", reader.Type)
	}
}

func resolveUnion(union *UnionResolution, value any) (any, error) {
	if union.WriterIsUnion {
		index, branchValue, ok := unionDatum(value)
		if !ok {
			return nil, fmt.Errorf("writer union requires dataeng.UnionValue, got %T", value)
		}
		if index < 0 || index >= len(union.Branches) {
			return nil, fmt.Errorf("union branch index %d out of range [0,%d)", index, len(union.Branches))
		}
		branch := union.Branches[index]
		resolved, err := resolveValue(branch, branchValue)
		if err != nil {
			return nil, fmt.Errorf("union branch %d: %w", index, err)
		}
		if union.ReaderIsUnion {
			readerIndex := union.ReaderIndices[index]
			if readerIndex < 0 {
				return nil, fmt.Errorf("writer union branch %d has no reader branch", index)
			}
			return UnionValue{Index: readerIndex, Value: resolved}, nil
		}
		return resolved, nil
	}

	resolved, err := resolveValue(union.Single, value)
	if err != nil {
		return nil, err
	}
	if !union.ReaderIsUnion {
		return resolved, nil
	}
	return UnionValue{Index: union.ReaderIndex, Value: resolved}, nil
}

func unionDatum(value any) (int, any, bool) {
	switch v := value.(type) {
	case UnionValue:
		return v.Index, v.Value, true
	case *UnionValue:
		if v == nil {
			return 0, nil, false
		}
		return v.Index, v.Value, true
	default:
		return 0, nil, false
	}
}

func promoteValue(res *Resolution, value any) (any, error) {
	switch res.Promotion {
	case IntToLong:
		value, err := int32Value(value)
		if err != nil {
			return nil, err
		}
		return int64(value), nil
	case IntToFloat:
		value, err := int32Value(value)
		if err != nil {
			return nil, err
		}
		return float32(value), nil
	case IntToDouble:
		value, err := int32Value(value)
		if err != nil {
			return nil, err
		}
		return float64(value), nil
	case LongToFloat:
		value, err := int64Value(value)
		if err != nil {
			return nil, err
		}
		return float32(value), nil
	case LongToDouble:
		value, err := int64Value(value)
		if err != nil {
			return nil, err
		}
		return float64(value), nil
	case FloatToDouble:
		value, err := float32Value(value)
		if err != nil {
			return nil, err
		}
		return float64(value), nil
	case StringToBytes:
		value, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("expected string, got %T", value)
		}
		return []byte(value), nil
	case BytesToString:
		value, err := bytesValue(value)
		if err != nil {
			return nil, err
		}
		return string(value), nil
	default:
		return nil, fmt.Errorf("internal resolution error: unknown promotion %d", res.Promotion)
	}
}

func resolveRecord(res *Resolution, value any) (any, error) {
	fields, ok := recordFields(value)
	if !ok {
		return nil, fmt.Errorf("expected record object for %q, got %T", res.Reader.FullName, value)
	}
	out := make(map[string]any, len(res.Fields))
	for _, field := range res.Fields {
		if field.UseDefault {
			out[field.Reader.Name] = cloneValue(field.Default)
			continue
		}
		writerValue, ok := fields[field.Writer.Name]
		if !ok {
			return nil, fmt.Errorf("record %q is missing writer field %q", res.Writer.FullName, field.Writer.Name)
		}
		resolved, err := resolveValue(field.Resolution, writerValue)
		if err != nil {
			return nil, fmt.Errorf("field %q: %w", field.Reader.Name, err)
		}
		out[field.Reader.Name] = resolved
	}
	return out, nil
}

func resolveArray(res *Resolution, value any) (any, error) {
	values, ok := sliceValues(value)
	if !ok {
		return nil, fmt.Errorf("expected array, got %T", value)
	}
	out := make([]any, len(values))
	for i, item := range values {
		resolved, err := resolveValue(res.Array, item)
		if err != nil {
			return nil, fmt.Errorf("array element %d: %w", i, err)
		}
		out[i] = resolved
	}
	return out, nil
}

func resolveMap(res *Resolution, value any) (any, error) {
	values, ok := stringMapValues(value)
	if !ok {
		return nil, fmt.Errorf("expected map, got %T", value)
	}
	out := make(map[string]any, len(values))
	for key, item := range values {
		resolved, err := resolveValue(res.Map, item)
		if err != nil {
			return nil, fmt.Errorf("map key %q: %w", key, err)
		}
		out[key] = resolved
	}
	return out, nil
}

func int32Value(value any) (int32, error) {
	i, err := integerValue(value, 32)
	if err != nil {
		return 0, err
	}
	return int32(i), nil
}

func int64Value(value any) (int64, error) {
	return integerValue(value, 64)
}

func integerValue(value any, bits int) (int64, error) {
	switch v := value.(type) {
	case json.Number:
		i, err := parseIntegerText(v.String(), bits)
		if err != nil {
			return 0, fmt.Errorf("expected integer: %w", err)
		}
		return i, nil
	case int:
		return rangeInt64(int64(v), bits)
	case int8:
		return rangeInt64(int64(v), bits)
	case int16:
		return rangeInt64(int64(v), bits)
	case int32:
		return rangeInt64(int64(v), bits)
	case int64:
		return rangeInt64(v, bits)
	case uint:
		return rangeUint64(uint64(v), bits)
	case uint8:
		return rangeUint64(uint64(v), bits)
	case uint16:
		return rangeUint64(uint64(v), bits)
	case uint32:
		return rangeUint64(uint64(v), bits)
	case uint64:
		return rangeUint64(v, bits)
	case float32:
		return rangeFloat(float64(v), bits)
	case float64:
		return rangeFloat(v, bits)
	default:
		return 0, fmt.Errorf("expected integer, got %T", value)
	}
}

func rangeInt64(value int64, bits int) (int64, error) {
	if bits == 32 && (value < math.MinInt32 || value > math.MaxInt32) {
		return 0, fmt.Errorf("integer %d is outside int32 range", value)
	}
	return value, nil
}

func rangeUint64(value uint64, bits int) (int64, error) {
	max := uint64(math.MaxInt64)
	if bits == 32 {
		max = math.MaxInt32
	}
	if value > max {
		return 0, fmt.Errorf("integer %d is outside int%d range", value, bits)
	}
	return int64(value), nil
}

func rangeFloat(value float64, bits int) (int64, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) || math.Trunc(value) != value {
		return 0, fmt.Errorf("expected integer, got %v", value)
	}
	if bits == 32 {
		if value < math.MinInt32 || value > math.MaxInt32 {
			return 0, fmt.Errorf("integer %v is outside int32 range", value)
		}
	} else {
		if value < math.MinInt64 || value >= math.MaxInt64 {
			return 0, fmt.Errorf("integer %v is outside int64 range", value)
		}
	}
	return int64(value), nil
}

func float32Value(value any) (float32, error) {
	f, err := floatValue(value, 32)
	if err != nil {
		return 0, err
	}
	if math.IsInf(float64(f), 0) {
		return 0, fmt.Errorf("value %v is outside float32 range", value)
	}
	return float32(f), nil
}

func float64Value(value any) (float64, error) {
	return floatValue(value, 64)
}

func floatValue(value any, bits int) (float64, error) {
	switch v := value.(type) {
	case json.Number:
		f, err := strconv.ParseFloat(v.String(), bits)
		if err != nil {
			return 0, fmt.Errorf("expected number, got %q", v.String())
		}
		return f, nil
	case float64:
		return v, nil
	case float32:
		return float64(v), nil
	case int:
		return float64(v), nil
	case int8:
		return float64(v), nil
	case int16:
		return float64(v), nil
	case int32:
		return float64(v), nil
	case int64:
		return float64(v), nil
	case uint:
		return float64(v), nil
	case uint8:
		return float64(v), nil
	case uint16:
		return float64(v), nil
	case uint32:
		return float64(v), nil
	case uint64:
		return float64(v), nil
	default:
		return 0, fmt.Errorf("expected number, got %T", value)
	}
}

func bytesValue(value any) ([]byte, error) {
	switch v := value.(type) {
	case []byte:
		return append([]byte(nil), v...), nil
	case string:
		return bytesDefault(v)
	default:
		return nil, fmt.Errorf("expected bytes, got %T", value)
	}
}

func recordFields(value any) (map[string]any, bool) {
	if value == nil {
		return nil, false
	}
	if fields, ok := value.(map[string]any); ok {
		return fields, true
	}

	rv := reflect.ValueOf(value)
	for rv.Kind() == reflect.Interface || rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return nil, false
		}
		rv = rv.Elem()
	}
	switch rv.Kind() {
	case reflect.Map:
		if rv.Type().Key().Kind() != reflect.String {
			return nil, false
		}
		fields := make(map[string]any, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			fields[iter.Key().String()] = iter.Value().Interface()
		}
		return fields, true
	case reflect.Struct:
		fields := make(map[string]any, rv.NumField())
		rt := rv.Type()
		for i := 0; i < rv.NumField(); i++ {
			field := rt.Field(i)
			if !field.IsExported() {
				continue
			}
			name := field.Name
			tag := field.Tag.Get("avro")
			if tag == "" {
				tag = field.Tag.Get("json")
			}
			if tag != "" {
				if comma := strings.IndexByte(tag, ','); comma >= 0 {
					tag = tag[:comma]
				}
				if tag != "" && tag != "-" {
					name = tag
				} else if tag == "-" {
					continue
				}
			}
			fields[name] = rv.Field(i).Interface()
		}
		return fields, true
	default:
		return nil, false
	}
}

func sliceValues(value any) ([]any, bool) {
	if value == nil {
		return nil, false
	}
	if values, ok := value.([]any); ok {
		return values, true
	}
	rv := reflect.ValueOf(value)
	for rv.Kind() == reflect.Interface || rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return nil, false
		}
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, false
	}
	values := make([]any, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		values[i] = rv.Index(i).Interface()
	}
	return values, true
}

func stringMapValues(value any) (map[string]any, bool) {
	if value == nil {
		return nil, false
	}
	if values, ok := value.(map[string]any); ok {
		return values, true
	}
	rv := reflect.ValueOf(value)
	for rv.Kind() == reflect.Interface || rv.Kind() == reflect.Pointer {
		if rv.IsNil() {
			return nil, false
		}
		rv = rv.Elem()
	}
	if rv.Kind() != reflect.Map || rv.Type().Key().Kind() != reflect.String {
		return nil, false
	}
	values := make(map[string]any, rv.Len())
	iter := rv.MapRange()
	for iter.Next() {
		values[iter.Key().String()] = iter.Value().Interface()
	}
	return values, true
}
