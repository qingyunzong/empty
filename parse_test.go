package dataeng

import (
	"strings"
	"testing"
)

func mustParse(t *testing.T, raw string) (Type, map[string]Named) {
	t.Helper()
	root, names, err := parseSchema(raw, nil)
	if err != nil {
		t.Fatalf("parseSchema: %v", err)
	}
	return root, names
}

func TestParseNamespaceInheritanceAndReset(t *testing.T) {
	raw := `{
	  "type": "record", "name": "Outer", "namespace": "com.acme",
	  "fields": [
	    {"name": "inner", "type": {"type": "record", "name": "Inner", "fields": [
	      {"name": "deep", "type": {"type": "record", "name": "x.y.Deep", "fields": []}},
	      {"name": "reset", "type": {"type": "record", "name": "Loose", "namespace": "", "fields": []}}
	    ]}},
	    {"name": "again", "type": "Inner"}
	  ]
	}`
	_, names := mustParse(t, raw)
	for _, want := range []string{"com.acme.Outer", "com.acme.Inner", "x.y.Deep", "Loose"} {
		if names[want] == nil {
			t.Errorf("missing named type %q", want)
		}
	}
	outer := names["com.acme.Outer"].(*Record)
	if got := outer.Fields[1].Type.(*Record).Name; got != "com.acme.Inner" {
		t.Errorf("unqualified reference resolved to %q, want com.acme.Inner", got)
	}
}

func TestParseRecursiveRecord(t *testing.T) {
	raw := `{"type":"record","name":"Node","namespace":"n","fields":[
	  {"name":"val","type":"long"},
	  {"name":"next","type":["null","Node"],"default":null}
	]}`
	root, _ := mustParse(t, raw)
	rec := root.(*Record)
	next := rec.Fields[1].Type.(*Union)
	if next.Types[1] != Type(rec) {
		t.Fatal("recursive reference did not resolve to the enclosing record")
	}
}

func TestParseAliases(t *testing.T) {
	raw := `{"type":"record","name":"New","namespace":"com.acme",
	  "aliases":["Old","other.ns.Older"],
	  "fields":[{"name":"renamed","type":"string","aliases":["orig"]}]}`
	root, _ := mustParse(t, raw)
	rec := root.(*Record)
	want := []string{"com.acme.Old", "other.ns.Older"}
	if strings.Join(rec.Aliases, ",") != strings.Join(want, ",") {
		t.Errorf("type aliases = %v, want %v", rec.Aliases, want)
	}
	if got := rec.Fields[0].Aliases; len(got) != 1 || got[0] != "orig" {
		t.Errorf("field aliases = %v, want [orig]", got)
	}
}

func TestParseUnionDefaultValidation(t *testing.T) {
	good := `{"type":"record","name":"R","fields":[
	  {"name":"a","type":["null","string"],"default":null},
	  {"name":"b","type":["string","null"],"default":"x"}
	]}`
	if _, _, err := parseSchema(good, nil); err != nil {
		t.Fatalf("valid union defaults rejected: %v", err)
	}

	bad := `{"type":"record","name":"R","fields":[
	  {"name":"a","type":["null","string"],"default":"x"}
	]}`
	_, _, err := parseSchema(bad, nil)
	if err == nil {
		t.Fatal("expected invalid union default error")
	}
	if !strings.Contains(err.Error(), `"a"`) {
		t.Errorf("error should name the field, got: %v", err)
	}
}

func TestParseEnumDefaultMustBeSymbol(t *testing.T) {
	raw := `{"type":"enum","name":"E","symbols":["A","B"],"default":"C"}`
	if _, _, err := parseSchema(raw, nil); err == nil {
		t.Fatal("expected enum default validation error")
	}
}

func TestParseUnionRejectsDuplicatesAndNesting(t *testing.T) {
	for _, raw := range []string{
		`["int","int"]`,
		`[["string"],"null"]`,
		`[{"type":"record","name":"R","fields":[]},"R"]`,
	} {
		if _, _, err := parseSchema(raw, nil); err == nil {
			t.Errorf("expected error for %s", raw)
		}
	}
}

func TestParseUnknownTypeName(t *testing.T) {
	raw := `{"type":"record","name":"R","namespace":"a.b","fields":[{"name":"f","type":"Missing"}]}`
	if _, _, err := parseSchema(raw, nil); err == nil {
		t.Fatal("expected unknown type error")
	}
}
