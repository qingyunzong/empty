package dataeng

import (
	"encoding/binary"
	"reflect"
	"testing"
)

func TestDecodeMySQLBinaryJSONScalars(t *testing.T) {
	tests := []struct {
		name string
		data []byte
		want any
	}{
		{"literal null", []byte{jsonbLiteral, 0}, nil},
		{"literal true", []byte{jsonbLiteral, 1}, true},
		{"literal false", []byte{jsonbLiteral, 2}, false},
		{"int16", []byte{jsonbInt16, 0xff, 0xff}, int64(-1)},
		{"uint16", []byte{jsonbUint16, 0xff, 0xff}, uint64(65535)},
		{"int32", append([]byte{jsonbInt32}, 0xfe, 0xff, 0xff, 0xff), int64(-2)},
		{"uint64", append([]byte{jsonbUint64}, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff), uint64(18446744073709551615)},
		{"string", []byte{jsonbString, 3, 'a', 'b', 'c'}, "abc"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := DecodeMySQLBinaryJSON(test.data)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, test.want) {
				t.Fatalf("got %#v (%T), want %#v (%T)", got, got, test.want, test.want)
			}
		})
	}
}

func TestDecodeMySQLBinaryJSONSmallObject(t *testing.T) {
	// one key "a" with an int32 value
	payload := make([]byte, 0, 16)
	payload = append(payload, 1, 0)              // count
	payload = append(payload, 16, 0)             // total object size
	payload = append(payload, 11, 0, 1, 0)       // key offset 11, key length 1
	payload = append(payload, jsonbInt32, 12, 0) // value type, offset 12
	payload = append(payload, 'a')
	payload = binary.LittleEndian.AppendUint32(payload, uint32(42))

	got, err := DecodeMySQLBinaryJSON(append([]byte{jsonbSmallObject}, payload...))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"a": int64(42)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestDecodeMySQLBinaryJSONSmallArray(t *testing.T) {
	payload := make([]byte, 0, 18)
	payload = append(payload, 2, 0)              // count
	payload = append(payload, 18, 0)             // total array size
	payload = append(payload, jsonbInt32, 10, 0) // first value at 10
	payload = append(payload, jsonbInt32, 14, 0) // second value at 14
	payload = binary.LittleEndian.AppendUint32(payload, uint32(1))
	payload = binary.LittleEndian.AppendUint32(payload, uint32(2))

	got, err := DecodeMySQLBinaryJSON(append([]byte{jsonbSmallArray}, payload...))
	if err != nil {
		t.Fatal(err)
	}
	want := []any{int64(1), int64(2)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}
