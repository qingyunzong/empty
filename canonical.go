package dataeng

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"
)

// canonicalValue renders a decoded scalar (and, as a fallback, a composite
// value) in one deterministic representation. It is used both for primary-key
// identity and before/after-image evidence, so two equivalent decodings such as
// int(1) and float64(1) must compare equal.
func canonicalValue(value Value) ([]byte, error) {
	if value == nil {
		return []byte("0"), nil
	}

	switch v := value.(type) {
	case bool:
		if v {
			return []byte("b:1"), nil
		}
		return []byte("b:0"), nil
	case string:
		return []byte("s:" + v), nil
	case []byte:
		return []byte("x:" + hex.EncodeToString(v)), nil
	case json.Number:
		return []byte("n:" + normalizeNumber(string(v))), nil
	case int:
		return []byte("n:" + strconv.FormatInt(int64(v), 10)), nil
	case int8:
		return []byte("n:" + strconv.FormatInt(int64(v), 10)), nil
	case int16:
		return []byte("n:" + strconv.FormatInt(int64(v), 10)), nil
	case int32:
		return []byte("n:" + strconv.FormatInt(int64(v), 10)), nil
	case int64:
		return []byte("n:" + strconv.FormatInt(v, 10)), nil
	case uint:
		return []byte("n:" + strconv.FormatUint(uint64(v), 10)), nil
	case uint8:
		return []byte("n:" + strconv.FormatUint(uint64(v), 10)), nil
	case uint16:
		return []byte("n:" + strconv.FormatUint(uint64(v), 10)), nil
	case uint32:
		return []byte("n:" + strconv.FormatUint(uint64(v), 10)), nil
	case uint64:
		return []byte("n:" + strconv.FormatUint(v, 10)), nil
	case float32:
		return []byte("n:" + formatFloat(float64(v), 32)), nil
	case float64:
		return []byte("n:" + formatFloat(v, 64)), nil
	case time.Time:
		return []byte("t:" + v.UTC().Format(time.RFC3339Nano)), nil
	}

	rv := reflect.ValueOf(value)
	return canonicalReflect(rv, make(map[visit]struct{}))
}

func formatFloat(value float64, bitSize int) string {
	switch {
	case math.IsNaN(value):
		return "NaN"
	case math.IsInf(value, 1):
		return "+Inf"
	case math.IsInf(value, -1):
		return "-Inf"
	}
	return normalizeNumber(strconv.FormatFloat(value, 'g', -1, bitSize))
}

func normalizeNumber(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return value
	}
	rat, ok := new(big.Rat).SetString(value)
	if !ok {
		return strings.ToLower(value)
	}
	return rat.RatString()
}

type visit struct {
	typ reflect.Type
	ptr uintptr
}

func canonicalReflect(rv reflect.Value, seen map[visit]struct{}) ([]byte, error) {
	if !rv.IsValid() {
		return []byte("0"), nil
	}

	if rv.CanInterface() {
		if value, handled, err := canonicalKnownType(rv.Interface()); handled {
			return value, err
		}
	}

	switch rv.Kind() {
	case reflect.Interface:
		if rv.IsNil() {
			return []byte("0"), nil
		}
		return canonicalReflect(rv.Elem(), seen)
	case reflect.Pointer, reflect.Map, reflect.Slice:
		if rv.IsNil() {
			return []byte("0"), nil
		}
		key := visit{typ: rv.Type(), ptr: rv.Pointer()}
		if _, exists := seen[key]; exists {
			return nil, fmt.Errorf("%w: cycle in %s", errUnsupportedValue, rv.Type())
		}
		seen[key] = struct{}{}
		defer delete(seen, key)
		if rv.Kind() == reflect.Pointer {
			return canonicalReflect(rv.Elem(), seen)
		}
		return canonicalComposite(rv, seen)
	case reflect.Bool:
		if rv.Bool() {
			return []byte("b:1"), nil
		}
		return []byte("b:0"), nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return []byte("n:" + strconv.FormatInt(rv.Int(), 10)), nil
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return []byte("n:" + strconv.FormatUint(rv.Uint(), 10)), nil
	case reflect.Uintptr:
		return []byte("u:" + strconv.FormatUint(rv.Uint(), 10)), nil
	case reflect.Float32:
		return []byte("n:" + formatFloat(rv.Float(), 32)), nil
	case reflect.Float64:
		return []byte("n:" + formatFloat(rv.Float(), 64)), nil
	case reflect.Complex64, reflect.Complex128:
		c := rv.Complex()
		return []byte(fmt.Sprintf("c:%s:%s",
			formatFloat(real(c), 64), formatFloat(imag(c), 64))), nil
	case reflect.String:
		return []byte("s:" + rv.String()), nil
	case reflect.Array:
		return canonicalComposite(rv, seen)
	case reflect.Struct:
		return canonicalStruct(rv, seen)
	default:
		return nil, fmt.Errorf("%w: %s", errUnsupportedValue, rv.Type())
	}
}

func canonicalComposite(rv reflect.Value, seen map[visit]struct{}) ([]byte, error) {
	switch rv.Kind() {
	case reflect.Slice, reflect.Array:
		var b strings.Builder
		fmt.Fprintf(&b, "a:%d:[", rv.Len())
		for i := 0; i < rv.Len(); i++ {
			item, err := canonicalReflect(rv.Index(i), seen)
			if err != nil {
				return nil, err
			}
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(escapePart(string(item)))
		}
		b.WriteByte(']')
		return []byte(b.String()), nil
	case reflect.Map:
		type pair struct {
			key   string
			value string
		}
		pairs := make([]pair, 0, rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			key, err := canonicalReflect(iter.Key(), seen)
			if err != nil {
				return nil, err
			}
			value, err := canonicalReflect(iter.Value(), seen)
			if err != nil {
				return nil, err
			}
			pairs = append(pairs, pair{key: string(key), value: string(value)})
		}
		sort.Slice(pairs, func(i, j int) bool { return pairs[i].key < pairs[j].key })
		var b strings.Builder
		fmt.Fprintf(&b, "m:%d:{", len(pairs))
		for i, item := range pairs {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(escapePart(item.key))
			b.WriteByte(':')
			b.WriteString(escapePart(item.value))
		}
		b.WriteByte('}')
		return []byte(b.String()), nil
	default:
		return nil, fmt.Errorf("%w: %s", errUnsupportedValue, rv.Type())
	}
}

func canonicalStruct(rv reflect.Value, seen map[visit]struct{}) ([]byte, error) {
	type field struct {
		name  string
		value string
	}
	fields := make([]field, 0, rv.NumField())
	for i := 0; i < rv.NumField(); i++ {
		fieldType := rv.Type().Field(i)
		if fieldType.PkgPath != "" {
			return nil, fmt.Errorf("%w: unexported field %s.%s",
				errUnsupportedValue, rv.Type(), fieldType.Name)
		}
		value, err := canonicalReflect(rv.Field(i), seen)
		if err != nil {
			return nil, err
		}
		fields = append(fields, field{name: fieldType.Name, value: string(value)})
	}
	sort.Slice(fields, func(i, j int) bool { return fields[i].name < fields[j].name })
	var b strings.Builder
	fmt.Fprintf(&b, "r:%s:%d:{", rv.Type().String(), len(fields))
	for i, item := range fields {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(escapePart(item.name))
		b.WriteByte(':')
		b.WriteString(escapePart(item.value))
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}

func canonicalKnownType(value any) ([]byte, bool, error) {
	switch value.(type) {
	case bool, string, []byte, json.Number,
		int, int8, int16, int32, int64,
		uint, uint8, uint16, uint32, uint64,
		float32, float64, time.Time:
		encoded, err := canonicalValue(value)
		return encoded, true, err
	default:
		return nil, false, nil
	}
}

func canonicalImage(image Image) ([]byte, error) {
	columns := sortedColumns(image)
	var b strings.Builder
	fmt.Fprintf(&b, "i:%d:{", len(columns))
	for i, column := range columns {
		if i > 0 {
			b.WriteByte(',')
		}
		value, err := canonicalValue(image[column])
		if err != nil {
			return nil, fmt.Errorf("column %q: %w", column, err)
		}
		b.WriteString(escapePart(column))
		b.WriteByte(':')
		b.WriteString(escapePart(string(value)))
	}
	b.WriteByte('}')
	return []byte(b.String()), nil
}
