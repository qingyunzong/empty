package dataeng

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strconv"
)

// asValues converts the common slice spellings accepted by the message types
// into []any. A nil value returns (nil, true).
func asValues(v any) ([]any, bool) {
	if v == nil {
		return nil, true
	}
	if values, ok := v.([]any); ok {
		return values, true
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, false
	}
	values := make([]any, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		values[i] = rv.Index(i).Interface()
	}
	return values, true
}

// asIndices converts accepted index spellings into []int.
func asIndices(v any) ([]int, bool) {
	if v == nil {
		return nil, true
	}
	if indices, ok := v.([]int); ok {
		return append([]int(nil), indices...), true
	}
	rv := reflect.ValueOf(v)
	if rv.Kind() != reflect.Slice && rv.Kind() != reflect.Array {
		return nil, false
	}
	indices := make([]int, rv.Len())
	for i := 0; i < rv.Len(); i++ {
		index, err := toInt(rv.Index(i).Interface())
		if err != nil {
			return nil, false
		}
		indices[i] = index
	}
	return indices, true
}

func toInt(v any) (int, error) {
	switch value := v.(type) {
	case int:
		return value, nil
	case int8:
		return int(value), nil
	case int16:
		return int(value), nil
	case int32:
		return int(value), nil
	case int64:
		return int(value), nil
	case uint:
		return int(value), nil
	case uint8:
		return int(value), nil
	case uint16:
		return int(value), nil
	case uint32:
		return int(value), nil
	case uint64:
		if value > math.MaxInt {
			return 0, fmt.Errorf("integer overflows int")
		}
		return int(value), nil
	case float32:
		return floatToInt(float64(value))
	case float64:
		return floatToInt(value)
	case json.Number:
		n, err := strconv.ParseInt(string(value), 10, 64)
		if err != nil {
			return 0, err
		}
		return int(n), nil
	default:
		return 0, fmt.Errorf("expected integer, got %T", v)
	}
}

func floatToInt(value float64) (int, error) {
	if math.Trunc(value) != value || value < math.MinInt || value > math.MaxInt {
		return 0, fmt.Errorf("expected an integer, got %v", value)
	}
	return int(value), nil
}

// cloneValue makes message values safe to retain in frozen snapshots.
func cloneValue(v any) any {
	if v == nil {
		return nil
	}
	rv := reflect.ValueOf(v)
	return cloneReflect(rv).Interface()
}

func cloneReflect(rv reflect.Value) reflect.Value {
	switch rv.Kind() {
	case reflect.Interface:
		if rv.IsNil() {
			return reflect.Zero(rv.Type())
		}
		return cloneReflect(rv.Elem())
	case reflect.Pointer:
		if rv.IsNil() {
			return reflect.Zero(rv.Type())
		}
		copy := reflect.New(rv.Type().Elem())
		copy.Elem().Set(cloneReflect(rv.Elem()))
		return copy
	case reflect.Slice:
		if rv.IsNil() {
			return reflect.Zero(rv.Type())
		}
		copy := reflect.MakeSlice(rv.Type(), rv.Len(), rv.Len())
		for i := 0; i < rv.Len(); i++ {
			copy.Index(i).Set(cloneReflect(rv.Index(i)))
		}
		return copy
	case reflect.Map:
		if rv.IsNil() {
			return reflect.Zero(rv.Type())
		}
		copy := reflect.MakeMapWithSize(rv.Type(), rv.Len())
		iter := rv.MapRange()
		for iter.Next() {
			copy.SetMapIndex(cloneReflect(iter.Key()), cloneReflect(iter.Value()))
		}
		return copy
	case reflect.Array:
		copy := reflect.New(rv.Type()).Elem()
		for i := 0; i < rv.Len(); i++ {
			copy.Index(i).Set(cloneReflect(rv.Index(i)))
		}
		return copy
	default:
		return rv
	}
}

func cloneValues(values []any) []any {
	if values == nil {
		return nil
	}
	copy := make([]any, len(values))
	for i, value := range values {
		copy[i] = cloneValue(value)
	}
	return copy
}
