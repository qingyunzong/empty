package dataeng

import (
	"reflect"
	"testing"
)

// TestSpecificationResolutionSamples mirrors the resolution rules and small
// examples in the Avro specification.
func TestSpecificationResolutionSamples(t *testing.T) {
	tests := []struct {
		name   string
		writer string
		reader string
		ok     bool
	}{
		{
			name:   "record alias",
			writer: `{"type":"record","name":"Foo","fields":[{"name":"x","type":"int"}]}`,
			reader: `{"type":"record","name":"Bar","aliases":["Foo"],"fields":[{"name":"x","type":"int"}]}`,
			ok:     true,
		},
		{
			name:   "record field order and added default",
			writer: `{"type":"record","name":"R","fields":[{"name":"a","type":"int"},{"name":"b","type":"string"}]}`,
			reader: `{"type":"record","name":"R","fields":[{"name":"b","type":"string"},{"name":"a","type":"int"},{"name":"c","type":"double","default":1}]}`,
			ok:     true,
		},
		{
			name:   "record added field without default",
			writer: `{"type":"record","name":"R","fields":[{"name":"a","type":"int"}]}`,
			reader: `{"type":"record","name":"R","fields":[{"name":"a","type":"int"},{"name":"c","type":"double"}]}`,
			ok:     false,
		},
		{
			name:   "record name mismatch",
			writer: `{"type":"record","name":"A","fields":[]}`,
			reader: `{"type":"record","name":"B","fields":[]}`,
			ok:     false,
		},
		{
			name:   "array item promotion",
			writer: `{"type":"array","items":"int"}`,
			reader: `{"type":"array","items":"long"}`,
			ok:     true,
		},
		{
			name:   "map value promotion",
			writer: `{"type":"map","values":"int"}`,
			reader: `{"type":"map","values":"double"}`,
			ok:     true,
		},
		{
			name:   "fixed size mismatch",
			writer: `{"type":"fixed","name":"F","size":4}`,
			reader: `{"type":"fixed","name":"F","size":8}`,
			ok:     false,
		},
		{
			name:   "union to non-union requires all writer branches",
			writer: `["null","string"]`,
			reader: `"string"`,
			ok:     false,
		},
		{
			name:   "non-union to union first match",
			writer: `"int"`,
			reader: `["long","double"]`,
			ok:     true,
		},
		{
			name:   "both unions",
			writer: `["null","string"]`,
			reader: `["null","bytes"]`,
			ok:     true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			writer := mustSchema(t, tc.writer)
			reader := mustSchema(t, tc.reader)
			if got := Compatible(writer, reader); got != tc.ok {
				t.Fatalf("Compatible = %v, want %v", got, tc.ok)
			}
			_, err := NewResolver(writer, reader)
			if gotOK := err == nil; gotOK != tc.ok {
				t.Fatalf("NewResolver error = %v, want ok=%v", err, tc.ok)
			}
		})
	}
}

func TestSpecificationRecordIgnoredWriterFieldAndAlias(t *testing.T) {
	writer := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"keep","type":"int"},
			{"name":"gone","type":"string"}
		]
	}`)
	reader := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"renamed","aliases":["keep"],"type":"long"},
			{"name":"added","type":{"type":"array","items":"int"},"default":[1,2]}
		]
	}`)
	got, err := Resolve(writer, reader, map[string]any{"keep": int32(1), "gone": "x"})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"renamed": int64(1), "added": []any{int32(1), int32(2)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestExplicitEmptyNamespaceOverridesEnclosingNamespace(t *testing.T) {
	schema := mustSchema(t, `{
		"type":"record","name":"a.Root","fields":[
			{"name":"child","type":{
				"type":"record","name":"Global","namespace":"","fields":[]
			}}
		]
	}`)
	if got := schema.Fields[0].Type.FullName; got != "Global" {
		t.Fatalf("child full name = %q, want Global", got)
	}
}

func TestRecursiveDefaultExpansionIsRejected(t *testing.T) {
	schema := mustSchema(t, `{
		"type":"record","name":"Node","fields":[
			{"name":"child","type":"Node","default":{}}
		]
	}`)
	if _, err := DefaultValue(schema, map[string]any{}); err == nil {
		t.Fatal("recursive default expansion unexpectedly succeeded")
	}
}

func TestHandlerAndJSONEntryPoint(t *testing.T) {
	handler, err := NewHandlerFromJSON(
		[]byte(`{"type":"record","name":"R","fields":[{"name":"n","type":"int"}]}`),
		[]byte(`{"type":"record","name":"R","fields":[{"name":"n","type":"long"}]}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	got, err := handler.ResolveJSON([]byte(`{"n":1e2}`))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"n": int64(100)}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestStringBytesPromotionDatum(t *testing.T) {
	got, err := Resolve(&Schema{Type: String}, &Schema{Type: Bytes}, "abc")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []byte("abc")) {
		t.Fatalf("string->bytes = %#v", got)
	}
	got, err = Resolve(&Schema{Type: Bytes}, &Schema{Type: String}, []byte("abc"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "abc" {
		t.Fatalf("bytes->string = %#v", got)
	}
}
