package dataeng

import (
	"reflect"
	"sync"
	"testing"
)

func TestPrimitiveCompatibilityAndPromotion(t *testing.T) {
	kinds := []Kind{Null, Boolean, Int, Long, Float, Double, Bytes, String}
	expected := func(writer, reader Kind) bool {
		if writer == reader {
			return true
		}
		switch {
		case writer == Int && (reader == Long || reader == Float || reader == Double):
			return true
		case writer == Long && (reader == Float || reader == Double):
			return true
		case writer == Float && reader == Double:
			return true
		case writer == String && reader == Bytes:
			return true
		case writer == Bytes && reader == String:
			return true
		default:
			return false
		}
	}

	for _, writerKind := range kinds {
		for _, readerKind := range kinds {
			writer := &Schema{Type: writerKind}
			reader := &Schema{Type: readerKind}
			want := expected(writerKind, readerKind)
			if got := Compatible(writer, reader); got != want {
				t.Errorf("Compatible(%s,%s) = %v, want %v", writerKind, readerKind, got, want)
			}
			_, err := NewResolver(writer, reader)
			if gotOK := err == nil; gotOK != want {
				t.Errorf("NewResolver(%s,%s) error = %v, want compatible=%v", writerKind, readerKind, err, want)
			}
		}
	}
}

func TestNumericPromotionValues(t *testing.T) {
	tests := []struct {
		writer Kind
		reader Kind
		input  any
		want   any
	}{
		{Int, Long, int32(7), int64(7)},
		{Int, Float, int32(7), float32(7)},
		{Int, Double, int32(7), float64(7)},
		{Long, Float, int64(7), float32(7)},
		{Long, Double, int64(7), float64(7)},
		{Float, Double, float32(1.25), float64(1.25)},
	}
	for _, tc := range tests {
		got, err := Resolve(&Schema{Type: tc.writer}, &Schema{Type: tc.reader}, tc.input)
		if err != nil {
			t.Errorf("%s->%s: %v", tc.writer, tc.reader, err)
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s->%s = %#v (%T), want %#v (%T)", tc.writer, tc.reader, got, got, tc.want, tc.want)
		}
	}
}

func TestRecordResolutionWithNamespaceAliasesAndDefaults(t *testing.T) {
	writer := mustSchema(t, `{
		"type":"record","name":"old.User","fields":[
			{"name":"old_name","type":"string"},
			{"name":"dropped","type":"int"},
			{"name":"age","type":"int"}
		]
	}`)
	reader := mustSchema(t, `{
		"type":"record","name":"new.User","aliases":["old.User"],"fields":[
			{"name":"name","aliases":["old_name"],"type":"string"},
			{"name":"age","type":"long"},
			{"name":"active","type":"boolean","default":true},
			{"name":"note","type":["null","string"],"default":null}
		]
	}`)

	resolver, err := NewResolver(writer, reader)
	if err != nil {
		t.Fatal(err)
	}
	got, err := resolver.Resolve(map[string]any{
		"old_name": "adrian",
		"dropped":  int32(9),
		"age":      int32(41),
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"name":   "adrian",
		"age":    int64(41),
		"active": true,
		"note":   UnionValue{Index: 0, Value: nil},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}

	// Defaults are cloned, not shared between records.
	first := got.(map[string]any)
	secondAny, err := resolver.Resolve(map[string]any{
		"old_name": "b",
		"dropped":  int32(1),
		"age":      int32(2),
	})
	if err != nil {
		t.Fatal(err)
	}
	second := secondAny.(map[string]any)
	firstNote := first["note"].(UnionValue)
	secondNote := second["note"].(UnionValue)
	if firstNote.Value != nil || secondNote.Value != nil {
		t.Fatalf("union default values = %#v %#v", firstNote, secondNote)
	}
}

func TestRecordRejectsMissingReaderFieldDefault(t *testing.T) {
	writer := mustSchema(t, `{"type":"record","name":"R","fields":[{"name":"x","type":"int"}]}`)
	reader := mustSchema(t, `{"type":"record","name":"R","fields":[
		{"name":"x","type":"int"},
		{"name":"y","type":"int"}
	]}`)
	if _, err := NewResolver(writer, reader); err == nil {
		t.Fatal("expected missing reader field default to fail")
	}
}

func TestUnionResolutionSelectsFirstMatchingReaderBranch(t *testing.T) {
	writer := mustSchema(t, `"string"`)
	reader := mustSchema(t, `["bytes","string"]`)

	got, err := Resolve(writer, reader, "hello")
	if err != nil {
		t.Fatal(err)
	}
	want := UnionValue{Index: 0, Value: []byte("hello")} // bytes is first
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestUnionWriterAndReaderPreserveBranchIndices(t *testing.T) {
	writer := mustSchema(t, `["int","string"]`)
	reader := mustSchema(t, `["long","bytes"]`)

	resolver, err := NewResolver(writer, reader)
	if err != nil {
		t.Fatal(err)
	}

	got, err := resolver.Resolve(UnionValue{Index: 0, Value: int32(12)})
	if err != nil {
		t.Fatal(err)
	}
	if want := (UnionValue{Index: 0, Value: int64(12)}); !reflect.DeepEqual(got, want) {
		t.Fatalf("int branch = %#v, want %#v", got, want)
	}

	got, err = resolver.Resolve(UnionValue{Index: 1, Value: "x"})
	if err != nil {
		t.Fatal(err)
	}
	if want := (UnionValue{Index: 1, Value: []byte("x")}); !reflect.DeepEqual(got, want) {
		t.Fatalf("string branch = %#v, want %#v", got, want)
	}
}

func TestWriterUnionRequiresExplicitBranch(t *testing.T) {
	writer := mustSchema(t, `["null","string"]`)
	reader := mustSchema(t, `["null","string"]`)
	_, err := Resolve(writer, reader, nil)
	if err == nil {
		t.Fatal("bare nil must not be guessed as the null branch")
	}
}

func TestReaderUnionFirstBranchDefaultNeverGuessedByName(t *testing.T) {
	writer := mustSchema(t, `{"type":"record","name":"R","fields":[]}`)
	readerOK := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"x","type":["null","string"],"default":null}
		]
	}`)
	resolver, err := NewResolver(writer, readerOK)
	if err != nil {
		t.Fatal(err)
	}
	got, err := resolver.Resolve(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"x": UnionValue{Index: 0, Value: nil}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}

	// The literal null does not fit the first ("string") branch. A resolver
	// must not scan the union and pick the branch named "null".
	readerBad := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"x","type":["string","null"],"default":null}
		]
	}`)
	if _, err := NewResolver(writer, readerBad); err == nil {
		t.Fatal("expected union default against first branch to fail")
	}
}

func TestReaderUnionKeepsFirstMatchedBranchEvenIfLaterBranchIsExact(t *testing.T) {
	writer := mustSchema(t, `"int"`)
	reader := mustSchema(t, `["long","int"]`)
	got, err := Resolve(writer, reader, int32(5))
	if err != nil {
		t.Fatal(err)
	}
	if want := (UnionValue{Index: 0, Value: int64(5)}); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want first-match %#v", got, want)
	}
}

func TestUnionIncompatibility(t *testing.T) {
	tests := []struct {
		writer string
		reader string
		ok     bool
	}{
		{`["null","string"]`, `"string"`, false},
		{`["int","string"]`, `["long","bytes"]`, true},
		{`["int","string"]`, `["long","null"]`, false},
		{`"null"`, `["string","null"]`, true},
	}
	for _, tc := range tests {
		writer := mustSchema(t, tc.writer)
		reader := mustSchema(t, tc.reader)
		if got := Compatible(writer, reader); got != tc.ok {
			t.Errorf("Compatible(%s,%s) = %v, want %v", tc.writer, tc.reader, got, tc.ok)
		}
		_, err := NewResolver(writer, reader)
		if gotOK := err == nil; gotOK != tc.ok {
			t.Errorf("NewResolver(%s,%s) error = %v, want ok=%v", tc.writer, tc.reader, err, tc.ok)
		}
	}
}

func TestArrayMapAndReflectionInputs(t *testing.T) {
	writer := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"nums","type":{"type":"array","items":"int"}},
			{"name":"data","type":{"type":"map","values":"string"}}
		]
	}`)
	reader := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"nums","type":{"type":"array","items":"double"}},
			{"name":"data","type":{"type":"map","values":"bytes"}}
		]
	}`)

	resolver, err := NewResolver(writer, reader)
	if err != nil {
		t.Fatal(err)
	}
	got, err := resolver.Resolve(struct {
		Nums []int32           `avro:"nums"`
		Data map[string]string `avro:"data"`
	}{
		Nums: []int32{1, 2},
		Data: map[string]string{"a": "x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"nums": []any{float64(1), float64(2)},
		"data": map[string]any{"a": []byte("x")},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}
}

func TestEnumAndFixedResolution(t *testing.T) {
	writer := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"e","type":{"type":"enum","name":"E","symbols":["A","B"]}},
			{"name":"f","type":{"type":"fixed","name":"F","size":2}}
		]
	}`)
	reader := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"e","type":{"type":"enum","name":"NewE","aliases":["E"],"symbols":["A","C"],"default":"C"}},
			{"name":"f","type":{"type":"fixed","name":"NewF","aliases":["F"],"size":2}}
		]
	}`)

	got, err := Resolve(writer, reader, map[string]any{
		"e": "B",
		"f": []byte{1, 2},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"e": "C", "f": []byte{1, 2}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v, want %#v", got, want)
	}

	badReader := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"e","type":{"type":"enum","name":"E","symbols":["A","C"]}}
		]
	}`)
	badWriter := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"e","type":{"type":"enum","name":"E","symbols":["A","B"]}}
		]
	}`)
	if _, err := NewResolver(badWriter, badReader); err == nil {
		t.Fatal("expected missing enum symbol without default to fail")
	}

	badFixedReader := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"f","type":{"type":"fixed","name":"F","size":3}}
		]
	}`)
	badFixedWriter := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"f","type":{"type":"fixed","name":"F","size":2}}
		]
	}`)
	if _, err := NewResolver(badFixedWriter, badFixedReader); err == nil {
		t.Fatal("expected fixed size mismatch to fail")
	}
}

func TestRecursiveResolutionTerminates(t *testing.T) {
	writer := mustSchema(t, `{
		"type":"record","name":"Node","fields":[
			{"name":"value","type":"long"},
			{"name":"next","type":["null","Node"],"default":null}
		]
	}`)
	reader := mustSchema(t, `{
		"type":"record","name":"Node","fields":[
			{"name":"value","type":"double"},
			{"name":"next","type":["null","Node"],"default":null},
			{"name":"label","type":"string","default":"node"}
		]
	}`)

	resolver, err := NewResolver(writer, reader)
	if err != nil {
		t.Fatal(err)
	}

	var datum any = map[string]any{
		"value": int64(49),
		"next":  UnionValue{Index: 0, Value: nil},
	}
	for i := 48; i >= 0; i-- {
		datum = map[string]any{
			"value": int64(i),
			"next":  UnionValue{Index: 1, Value: datum},
		}
	}
	got, err := resolver.Resolve(datum)
	if err != nil {
		t.Fatal(err)
	}
	node := got.(map[string]any)
	if node["label"] != "node" {
		t.Fatalf("label = %#v", node["label"])
	}
	if _, ok := node["next"].(UnionValue); !ok {
		t.Fatalf("next = %#v", node["next"])
	}
}

func TestReaderDefaultsAreClonedPerDatum(t *testing.T) {
	writer := mustSchema(t, `{"type":"record","name":"R","fields":[]}`)
	reader := mustSchema(t, `{
		"type":"record","name":"R","fields":[
			{"name":"tags","type":{"type":"array","items":"string"},"default":["a","b"]}
		]
	}`)
	resolver, err := NewResolver(writer, reader)
	if err != nil {
		t.Fatal(err)
	}
	first, err := resolver.Resolve(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	firstRecord := first.(map[string]any)
	firstRecord["tags"].([]any)[0] = "mutated"
	second, err := resolver.Resolve(map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	secondRecord := second.(map[string]any)
	want := []any{"a", "b"}
	if !reflect.DeepEqual(secondRecord["tags"], want) {
		t.Fatalf("second tags = %#v, want %#v", secondRecord["tags"], want)
	}
}

func TestResolverConcurrentUse(t *testing.T) {
	writer := mustSchema(t, `{"type":"record","name":"R","fields":[
		{"name":"x","type":"int"},
		{"name":"u","type":["null","string"]}
	]}`)
	reader := mustSchema(t, `{"type":"record","name":"R","fields":[
		{"name":"x","type":"long"},
		{"name":"u","type":["null","bytes"]},
		{"name":"tag","type":"string","default":"ok"}
	]}`)
	resolver, err := NewResolver(writer, reader)
	if err != nil {
		t.Fatal(err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			got, err := resolver.Resolve(map[string]any{
				"x": int32(i),
				"u": UnionValue{Index: 1, Value: "s"},
			})
			if err != nil {
				t.Errorf("resolve %d: %v", i, err)
				return
			}
			record := got.(map[string]any)
			if record["x"] != int64(i) || record["tag"] != "ok" {
				t.Errorf("resolve %d = %#v", i, got)
			}
		}(i)
	}
	wg.Wait()
}
