package dataeng

import (
	"errors"
	"testing"
)

func usersV1() Relation {
	return Relation{
		ID:        42,
		Version:   1,
		Namespace: "public",
		Name:      "users",
		Columns: []Column{
			{Name: "id", Type: "int8"},
			{Name: "name", Type: "text", Nullable: true},
		},
		PrimaryKey: []string{"id"},
	}
}

func usersV2() Relation {
	relation := usersV1()
	relation.Version = 2
	relation.Columns = append(relation.Columns, Column{Name: "email", Type: "text", Nullable: true})
	return relation
}

func userRow(id, name string) Row {
	return Row{"id": TextValue(id), "name": TextValue(name)}
}

func userRowV2(id, name, email string) Row {
	row := userRow(id, name)
	row["email"] = TextValue(email)
	return row
}

func TestRelationValidationAndKeys(t *testing.T) {
	t.Parallel()
	relation := usersV1()
	if err := relation.Validate(); err != nil {
		t.Fatal(err)
	}
	key1, err := relation.Key(userRow("7", "alice"))
	if err != nil {
		t.Fatal(err)
	}
	key2, err := relation.Key(userRow("7", "ALICE"))
	if err != nil {
		t.Fatal(err)
	}
	if key1 != key2 {
		t.Fatal("primary key identity must not depend on non-key columns")
	}
	relation2 := usersV2()
	keyV2, err := relation2.Key(userRowV2("7", "alice", "a@example.com"))
	if err != nil {
		t.Fatal(err)
	}
	if key1.Encoded != keyV2.Encoded {
		t.Fatal("same primary key columns should encode identically")
	}
	if key1.RelationVersion == keyV2.RelationVersion {
		t.Fatal("row keys must carry the exact schema version")
	}
	if _, err := relation.Key(Row{"id": NullValue(), "name": TextValue("x")}); !errors.Is(err, ErrInvalidRow) {
		t.Fatalf("NULL primary key: got %v", err)
	}
	if _, err := relation.Key(Row{"name": TextValue("x")}); !errors.Is(err, ErrInvalidRow) {
		t.Fatalf("missing primary key: got %v", err)
	}
}

func TestRelationRowValidationIsVersionExact(t *testing.T) {
	t.Parallel()
	v1 := usersV1()
	v2 := usersV2()
	if err := v1.ValidateRow(userRowV2("1", "a", "a@x"), true); !errors.Is(err, ErrInvalidRow) {
		t.Fatalf("v1 must reject v2 columns, got %v", err)
	}
	if err := v2.ValidateRow(userRowV2("1", "a", "a@x"), true); err != nil {
		t.Fatal(err)
	}
	if err := v1.ValidateRow(Row{"id": TextValue("1")}, true); !errors.Is(err, ErrInvalidRow) {
		t.Fatalf("full snapshot validation accepted a partial row: %v", err)
	}
	if err := v1.ValidateRow(Row{"id": TextValue("1")}, false); err != nil {
		t.Fatal(err)
	}
}

func TestRelationRegistryKeepsHistory(t *testing.T) {
	t.Parallel()
	registry := NewRelationRegistry()
	if err := registry.Add(usersV1(), MustParseLSN("0/1000")); err != nil {
		t.Fatal(err)
	}
	if err := registry.Add(usersV2(), MustParseLSN("0/1300")); err != nil {
		t.Fatal(err)
	}
	resolved, effective, ok := registry.Resolve(42, 1)
	if !ok || !resolved.Equal(usersV1()) || effective != MustParseLSN("0/1000") {
		t.Fatalf("resolve v1 = %v, %s, %v", resolved.Version, effective, ok)
	}
	atOld, _, ok := registry.EffectiveAt(42, MustParseLSN("0/1200"))
	if !ok || atOld.Version != 1 {
		t.Fatalf("effective at old LSN = version %d", atOld.Version)
	}
	atNew, _, ok := registry.EffectiveAt(42, MustParseLSN("0/1400"))
	if !ok || atNew.Version != 2 {
		t.Fatalf("effective at new LSN = version %d", atNew.Version)
	}
	if _, _, ok := registry.Resolve(42, 99); ok {
		t.Fatal("unknown version resolved")
	}
}

func TestRelationRegistryRejectsVersionRewrites(t *testing.T) {
	t.Parallel()
	registry := NewRelationRegistry()
	if err := registry.Add(usersV1(), MustParseLSN("0/1000")); err != nil {
		t.Fatal(err)
	}
	if err := registry.Add(usersV1(), MustParseLSN("0/1000")); err != nil {
		t.Fatalf("idempotent add failed: %v", err)
	}
	changed := usersV1()
	changed.Columns[1].Type = "varchar"
	if err := registry.Add(changed, MustParseLSN("0/1000")); !errors.Is(err, ErrRelationVersionConflict) {
		t.Fatalf("rewrite error = %v", err)
	}
	if err := registry.Add(usersV1(), MustParseLSN("0/1300")); !errors.Is(err, ErrRelationVersionConflict) {
		t.Fatalf("same version at a new LSN error = %v", err)
	}
	if err := registry.Add(usersV2(), MustParseLSN("0/900")); !errors.Is(err, ErrRelationVersionConflict) {
		t.Fatalf("effective LSN regression error = %v", err)
	}
	if err := registry.Add(usersV1(), MustParseLSN("0/900")); !errors.Is(err, ErrRelationVersionConflict) {
		t.Fatalf("version regression error = %v", err)
	}
}

func TestRelationValidateRejectsBadSchemas(t *testing.T) {
	t.Parallel()
	invalids := []Relation{
		{},
		{ID: 1, Version: 1, Name: "t", Columns: []Column{{Name: "id"}}},
		{ID: 1, Version: 1, Name: "t", Columns: []Column{{Name: "id"}}, PrimaryKey: []string{"missing"}},
		{ID: 1, Version: 1, Name: "t", Columns: []Column{{Name: "id", Nullable: true}}, PrimaryKey: []string{"id"}},
		{ID: 1, Version: 1, Name: "t", Columns: []Column{{Name: "id"}, {Name: "id"}}, PrimaryKey: []string{"id"}},
	}
	for i, relation := range invalids {
		if err := relation.Validate(); !errors.Is(err, ErrInvalidRelation) {
			t.Fatalf("schema %d error = %v", i, err)
		}
	}
}
