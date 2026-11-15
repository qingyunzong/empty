package dataeng

import (
	"strings"
	"testing"
)

const userSchemaV1 = `{"type":"record","name":"User","namespace":"com.acme","fields":[
  {"name":"id","type":"long"}
]}`

const userSchemaV2 = `{"type":"record","name":"User","namespace":"com.acme","fields":[
  {"name":"id","type":"long"},
  {"name":"email","type":"string","default":""}
]}`

const eventSchema = `{"type":"record","name":"Event","namespace":"com.acme","fields":[
  {"name":"user","type":"User"}
]}`

func registryWithUser(raw string) *MemoryRegistry {
	reg := NewMemoryRegistry()
	reg.Register(Schema{ID: 2, Version: 1, Raw: raw})
	reg.Register(Schema{
		ID: 1, Version: 1, Raw: eventSchema,
		References: []Reference{{Name: "com.acme.User", ID: 2, Version: 1}},
	})
	return reg
}

func TestCompileBuildsReferenceClosure(t *testing.T) {
	c := NewCompiler(registryWithUser(userSchemaV1))
	cs, err := c.Compile(1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}
	if cs.Root.(*Record).Name != "com.acme.Event" {
		t.Fatalf("root = %v", cs.Root)
	}
	if cs.Lookup("com.acme.User") == nil || cs.Lookup("com.acme.Event") == nil {
		t.Fatal("named-type closure incomplete")
	}
	if len(cs.Refs) != 1 || cs.Refs[0].Root.(*Record).Name != "com.acme.User" {
		t.Fatalf("refs = %+v", cs.Refs)
	}
	// The field type is the referenced schema's root record.
	userField := cs.Root.(*Record).Fields[0].Type
	if userField != Type(cs.Refs[0].Root) {
		t.Fatal("reference name did not bind to the referenced root type")
	}

	again, err := c.Compile(1)
	if err != nil {
		t.Fatalf("Compile again: %v", err)
	}
	if again != cs {
		t.Fatal("expected cache hit to return the same *CompiledSchema")
	}
}

func TestCompileCacheCanonicalizesContent(t *testing.T) {
	reg := NewMemoryRegistry()
	reg.Register(Schema{ID: 1, Version: 1, Raw: `{ "type" : "record", "name":"R", "fields":[] }`})
	reg.Register(Schema{ID: 2, Version: 1, Raw: `{"name":"R","fields":[],"type":"record"}`})
	c := NewCompiler(reg)
	a, err := c.Compile(1)
	if err != nil {
		t.Fatal(err)
	}
	b, err := c.Compile(2)
	if err != nil {
		t.Fatal(err)
	}
	if a != b {
		t.Fatal("semantically identical schemas should share a cache entry")
	}
}

func TestReferenceVersionChangeDoesNotPolluteCache(t *testing.T) {
	reg := registryWithUser(userSchemaV1)
	c := NewCompiler(reg)

	old, err := c.Compile(1)
	if err != nil {
		t.Fatalf("Compile: %v", err)
	}

	// A new version of the referenced schema appears under the same id.
	reg.Register(Schema{ID: 2, Version: 2, Raw: userSchemaV2})
	reg.Register(Schema{
		ID: 1, Version: 2, Raw: eventSchema,
		References: []Reference{{Name: "com.acme.User", ID: 2, Version: 2}},
	})

	updated, err := c.Compile(1)
	if err != nil {
		t.Fatalf("Compile after ref update: %v", err)
	}
	if updated == old {
		t.Fatal("reference version change must produce a new cache entry")
	}
	if updated.Fingerprint == old.Fingerprint {
		t.Fatal("fingerprint must change when a referenced version changes")
	}

	// The previously compiled schema is untouched: old decoders keep working.
	oldUser := old.Lookup("com.acme.User").(*Record)
	if len(oldUser.Fields) != 1 {
		t.Fatalf("old compiled schema polluted: user has %d fields", len(oldUser.Fields))
	}
	newUser := updated.Lookup("com.acme.User").(*Record)
	if len(newUser.Fields) != 2 {
		t.Fatalf("new compiled schema should see 2 user fields, got %d", len(newUser.Fields))
	}

	// Rolling the registry back returns the original cached schema.
	reg.Register(Schema{ID: 2, Version: 1, Raw: userSchemaV1})
	reg.Register(Schema{
		ID: 1, Version: 1, Raw: eventSchema,
		References: []Reference{{Name: "com.acme.User", ID: 2, Version: 1}},
	})
	restored, err := c.Compile(1)
	if err != nil {
		t.Fatalf("Compile after rollback: %v", err)
	}
	if restored != old {
		t.Fatal("rollback should hit the original cache entry")
	}
}

func TestCompileCircularReferenceError(t *testing.T) {
	reg := NewMemoryRegistry()
	reg.Register(Schema{ID: 1, Version: 1, Raw: `"A"`, References: []Reference{{Name: "B", ID: 2, Version: 1}}})
	reg.Register(Schema{ID: 2, Version: 1, Raw: `"B"`, References: []Reference{{Name: "A", ID: 1, Version: 1}}})
	_, err := NewCompiler(reg).Compile(1)
	if err == nil || !strings.Contains(err.Error(), "circular") {
		t.Fatalf("expected circular reference error, got %v", err)
	}
}
