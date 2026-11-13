package dataeng

import (
	"strings"
	"testing"
)

func mustSchema(t *testing.T, text string) *Schema {
	t.Helper()
	schema, err := ParseSchemaString(text)
	if err != nil {
		t.Fatalf("ParseSchemaString(%s): %v", text, err)
	}
	return schema
}

func TestParseRecursiveSchemaUsesReferenceGraph(t *testing.T) {
	schema := mustSchema(t, `{
		"type": "record",
		"name": "Node",
		"namespace": "example",
		"fields": [
			{"name": "value", "type": "long"},
			{"name": "next", "type": ["null", "Node"], "default": null}
		]
	}`)

	if schema.FullName != "example.Node" {
		t.Fatalf("full name = %q", schema.FullName)
	}
	next := schema.Fields[1].Type
	if next.Type != Union || len(next.Branches) != 2 {
		t.Fatalf("next type = %s", next)
	}
	if next.Branches[1] != schema {
		t.Fatal("recursive reference did not reuse the named schema pointer")
	}

	// String rendering must terminate on the cyclic graph.
	if got := schema.String(); !strings.Contains(got, "example.Node") {
		t.Fatalf("String() = %q", got)
	}
}

func TestParseNamespacesAndAliases(t *testing.T) {
	schema := mustSchema(t, `{
		"type": "record",
		"name": "outer.inner.New",
		"aliases": ["Old", "other.Legacy"],
		"fields": [
			{"name": "child", "type": {
				"type": "record",
				"name": "Child",
				"fields": [{"name": "x", "type": "int"}]
			}}
		]
	}`)

	if schema.FullName != "outer.inner.New" || schema.Namespace != "outer.inner" || schema.Name != "New" {
		t.Fatalf("name = %q namespace = %q full = %q", schema.Name, schema.Namespace, schema.FullName)
	}
	wantAliases := []string{"outer.inner.Old", "other.Legacy"}
	if len(schema.Aliases) != len(wantAliases) {
		t.Fatalf("aliases = %v", schema.Aliases)
	}
	for i, want := range wantAliases {
		if schema.Aliases[i] != want {
			t.Fatalf("aliases = %v", schema.Aliases)
		}
	}
	if got := schema.Fields[0].Type.FullName; got != "outer.inner.Child" {
		t.Fatalf("nested full name = %q", got)
	}
}

func TestParseRejectsInvalidSchemas(t *testing.T) {
	tests := []string{
		``,
		`"NoSuchType"`,
		`["null", "null"]`,
		`["null", ["string"]]`,
		`{"type":"record","name":"R","fields":[{"name":"x","type":"Missing"}]}`,
		`{"type":"record","name":"R","fields":[{"name":"x","type":"int"},{"name":"x","type":"long"}]}`,
		`{"type":"record","name":"R","fields":[{"name":"x","type":"int"}]} {"type":"int"}`,
		`{"type":"enum","name":"E","symbols":["A","A"]}`,
		`{"type":"fixed","name":"F","size":-1}`,
	}
	for _, text := range tests {
		if _, err := ParseSchemaString(text); err == nil {
			t.Errorf("ParseSchemaString(%s) unexpectedly succeeded", text)
		}
	}
}

func TestParseUnionWithNamedBranches(t *testing.T) {
	schema := mustSchema(t, `[
		"null",
		{"type":"record","name":"A","fields":[]},
		{"type":"record","name":"B","fields":[]}
	]`)
	if len(schema.Branches) != 3 || schema.Branches[1].FullName != "A" || schema.Branches[2].FullName != "B" {
		t.Fatalf("union = %s", schema)
	}
}
