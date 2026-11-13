package dataeng

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestDefaultValuePrimitiveInterpretation(t *testing.T) {
	tests := []struct {
		schema string
		raw    string
		want   any
	}{
		{`"int"`, `100`, int32(100)},
		{`"int"`, `1e2`, int32(100)},
		{`"long"`, `9223372036854775807`, int64(9223372036854775807)},
		{`"float"`, `1`, float32(1)},
		{`"double"`, `1.5`, float64(1.5)},
		{`"string"`, `"hello"`, "hello"},
		{`"bytes"`, `"\u0000\u00ff"`, []byte{0, 0xff}},
		{`{"type":"fixed","name":"F","size":2}`, `"\u0001\u0002"`, []byte{1, 2}},
		{`{"type":"enum","name":"E","symbols":["A","B"]}`, `"B"`, "B"},
	}
	for _, tc := range tests {
		schema := mustSchema(t, tc.schema)
		var raw any
		dec := json.NewDecoder(strings.NewReader(tc.raw))
		dec.UseNumber()
		if err := dec.Decode(&raw); err != nil {
			t.Fatalf("decode %s: %v", tc.raw, err)
		}
		got, err := DefaultValue(schema, raw)
		if err != nil {
			t.Errorf("DefaultValue(%s, %s): %v", tc.schema, tc.raw, err)
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("DefaultValue(%s, %s) = %#v, want %#v", tc.schema, tc.raw, got, tc.want)
		}
	}
}

func TestDefaultValueRejectsWrongTypesAndRanges(t *testing.T) {
	tests := []struct {
		schema string
		raw    string
	}{
		{`"int"`, `1.5`},
		{`"int"`, `2147483648`},
		{`"long"`, `9223372036854775808`},
		{`"boolean"`, `1`},
		{`"string"`, `1`},
		{`"bytes"`, `"\u0100"`},
		{`{"type":"fixed","name":"F","size":2}`, `"x"`},
		{`{"type":"enum","name":"E","symbols":["A"]}`, `"B"`},
	}
	for _, tc := range tests {
		schema := mustSchema(t, tc.schema)
		var raw any
		dec := json.NewDecoder(strings.NewReader(tc.raw))
		dec.UseNumber()
		if err := dec.Decode(&raw); err != nil {
			t.Fatalf("decode %s: %v", tc.raw, err)
		}
		if _, err := DefaultValue(schema, raw); err == nil {
			t.Errorf("DefaultValue(%s, %s) unexpectedly succeeded", tc.schema, tc.raw)
		}
	}
}

func TestDefaultValueUnionUsesFirstBranchOnly(t *testing.T) {
	schema := mustSchema(t, `["int","long"]`)
	got, err := DefaultValue(schema, json.Number("1"))
	if err != nil {
		t.Fatal(err)
	}
	want := UnionValue{Index: 0, Value: int32(1)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}

	bad := mustSchema(t, `["string","null"]`)
	if _, err := DefaultValue(bad, nil); err == nil {
		t.Fatal("null must not select the second branch by name")
	}
}

func TestDefaultValueRecordAndCollections(t *testing.T) {
	schema := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"a","type":"int"},
			{"name":"b","type":"string","default":"fallback"},
			{"name":"c","type":{"type":"array","items":"long"},"default":[]},
			{"name":"d","type":{"type":"map","values":"boolean"},"default":{}},
			{"name":"e","type":["null","string"],"default":null}
		]
	}`)
	raw := map[string]any{
		"a": json.Number("3"),
		"c": []any{json.Number("1"), json.Number("2")},
		"d": map[string]any{"x": true},
	}
	got, err := DefaultValue(schema, raw)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"a": int32(3),
		"b": "fallback",
		"c": []any{int64(1), int64(2)},
		"d": map[string]any{"x": true},
		"e": UnionValue{Index: 0, Value: nil},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}

	if _, err := DefaultValue(schema, map[string]any{"a": json.Number("1"), "extra": json.Number("1")}); err == nil {
		t.Fatal("expected unknown record default field to fail")
	}
}
