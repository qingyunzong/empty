package dataeng

import (
	"strings"
	"testing"
)

func mustCompile(t *testing.T, raw string) *CompiledSchema {
	t.Helper()
	reg := NewMemoryRegistry()
	reg.Register(Schema{ID: 1, Version: 1, Raw: raw})
	cs, err := NewCompiler(reg).Compile(1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	return cs
}

func findFieldNode(t *testing.T, n *PlanNode, field string) *PlanNode {
	t.Helper()
	for _, f := range n.Fields {
		if f.Field == field {
			return f
		}
	}
	t.Fatalf("no plan node for field %q in %s", field, n.Path)
	return nil
}

func TestResolveIdenticalSchemas(t *testing.T) {
	raw := `{"type":"record","name":"R","fields":[
	  {"name":"a","type":"string"},
	  {"name":"b","type":{"type":"array","items":"long"}}
	]}`
	plan, err := Resolve(mustCompile(t, raw), mustCompile(t, raw))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if plan.Root.Action != ActionMatch || len(plan.Root.Fields) != 2 {
		t.Fatalf("unexpected plan:\n%s", plan)
	}
}

func TestResolvePromotion(t *testing.T) {
	writer := mustCompile(t, `{"type":"record","name":"R","fields":[{"name":"n","type":"int"}]}`)
	reader := mustCompile(t, `{"type":"record","name":"R","fields":[{"name":"n","type":"long"}]}`)
	plan, err := Resolve(writer, reader)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if got := findFieldNode(t, plan.Root, "n").Action; got != ActionPromote {
		t.Fatalf("action = %s, want promote", got)
	}
}

func TestResolveDefaultsSkipsAndAliases(t *testing.T) {
	writer := mustCompile(t, `{"type":"record","name":"R","fields":[
	  {"name":"id","type":"long"},
	  {"name":"legacy","type":"string"}
	]}`)
	reader := mustCompile(t, `{"type":"record","name":"R","fields":[
	  {"name":"user_id","type":"long","aliases":["id"]},
	  {"name":"added","type":"int","default":42}
	]}`)
	plan, err := Resolve(writer, reader)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	uid := findFieldNode(t, plan.Root, "user_id")
	if !uid.ViaAlias {
		t.Error("user_id should be matched via alias")
	}
	if got := findFieldNode(t, plan.Root, "added").Action; got != ActionDefault {
		t.Errorf("added action = %s, want default", got)
	}
	if got := findFieldNode(t, plan.Root, "legacy").Action; got != ActionSkip {
		t.Errorf("legacy action = %s, want skip", got)
	}
}

func TestResolveFirstIncompatiblePath(t *testing.T) {
	writer := mustCompile(t, `{"type":"record","name":"R","fields":[
	  {"name":"sub","type":{"type":"record","name":"S","fields":[{"name":"x","type":"int"}]}}
	]}`)
	reader := mustCompile(t, `{"type":"record","name":"R","fields":[
	  {"name":"sub","type":{"type":"record","name":"S","fields":[
	    {"name":"x","type":"int"},
	    {"name":"req","type":"string"}
	  ]}}
	]}`)
	_, err := Resolve(writer, reader)
	if err == nil {
		t.Fatal("expected incompatibility")
	}
	path, ok := IncompatiblePath(err)
	if !ok {
		t.Fatalf("expected *IncompatibleError, got %T: %v", err, err)
	}
	if path != "$.sub.req" {
		t.Fatalf("first incompatible path = %q, want $.sub.req", path)
	}
}

func TestResolveTypeMismatchPath(t *testing.T) {
	writer := mustCompile(t, `{"type":"record","name":"R","fields":[{"name":"tags","type":{"type":"array","items":"string"}}]}`)
	reader := mustCompile(t, `{"type":"record","name":"R","fields":[{"name":"tags","type":{"type":"array","items":"int"}}]}`)
	_, err := Resolve(writer, reader)
	path, ok := IncompatiblePath(err)
	if !ok || path != "$.tags[]" {
		t.Fatalf("path = %q ok=%v, want $.tags[]", path, ok)
	}
}

func TestResolveEnumDefault(t *testing.T) {
	writer := mustCompile(t, `{"type":"enum","name":"E","symbols":["A","B","C"]}`)
	reader := mustCompile(t, `{"type":"enum","name":"E","symbols":["A","B"],"default":"A"}`)
	plan, err := Resolve(writer, reader)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if plan.Root.Action != ActionEnumDefault {
		t.Fatalf("action = %s, want enum-default", plan.Root.Action)
	}

	noDefault := mustCompile(t, `{"type":"enum","name":"E","symbols":["A","B"]}`)
	if _, err := Resolve(writer, noDefault); err == nil {
		t.Fatal("expected enum incompatibility without reader default")
	}
}

func TestResolveRecursiveSchemasTerminate(t *testing.T) {
	raw := `{"type":"record","name":"Node","fields":[
	  {"name":"val","type":"long"},
	  {"name":"next","type":["null","Node"],"default":null}
	]}`
	plan, err := Resolve(mustCompile(t, raw), mustCompile(t, raw))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	next := findFieldNode(t, plan.Root, "next")
	if len(next.Branches) != 2 || next.Branches[1].Branch == nil || !next.Branches[1].Branch.Recursive {
		t.Fatalf("expected recursive back-reference, plan:\n%s", plan)
	}
}

func TestResolveUnions(t *testing.T) {
	writer := mustCompile(t, `["null","int"]`)
	reader := mustCompile(t, `["null","long"]`)
	plan, err := Resolve(writer, reader)
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if len(plan.Root.Branches) != 2 || plan.Root.Branches[1].Branch.Action != ActionPromote {
		t.Fatalf("unexpected union plan:\n%s", plan)
	}

	scalar := mustCompile(t, `"int"`)
	unionReader := mustCompile(t, `["string","long"]`)
	if _, err := Resolve(scalar, unionReader); err != nil {
		t.Fatalf("int should resolve into reader union via promotion: %v", err)
	}

	boolW := mustCompile(t, `"boolean"`)
	if _, err := Resolve(boolW, unionReader); err == nil {
		t.Fatal("boolean should not match any reader union branch")
	} else if !strings.Contains(err.Error(), "union") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestResolveRecordNameAlias(t *testing.T) {
	writer := mustCompile(t, `{"type":"record","name":"old.Name","fields":[]}`)
	reader := mustCompile(t, `{"type":"record","name":"new.Name","aliases":["old.Name"],"fields":[]}`)
	if _, err := Resolve(writer, reader); err != nil {
		t.Fatalf("record alias should match: %v", err)
	}
}
