package dataeng

import (
	"errors"
	"strings"
	"testing"
)

func TestNormalizeDigest(t *testing.T) {
	payload := []byte("payload")
	want := SHA256Digest(payload)
	bare := strings.TrimPrefix(want, digestPrefix)

	for _, in := range []string{want, bare, strings.ToUpper(bare)} {
		got, err := NormalizeDigest(in)
		if err != nil {
			t.Fatalf("NormalizeDigest(%q): %v", in, err)
		}
		if got != want {
			t.Fatalf("NormalizeDigest(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := NormalizeDigest("md5:abc"); !errors.Is(err, ErrInvalidDigest) {
		t.Fatalf("unsupported digest error = %v", err)
	}
	if _, err := NormalizeDigest("xyz"); !errors.Is(err, ErrInvalidDigest) {
		t.Fatalf("short digest error = %v", err)
	}
}

func TestManifestNormalizeSortsAndDeduplicates(t *testing.T) {
	zero := makeShard(t, 0, "v1", "a")
	one := makeShard(t, 1, "v1", "b")
	m := Manifest{SchemaVersion: "v1", Shards: []Shard{one.shard, zero.shard, zero.shard}}

	normalized, err := m.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if len(normalized.Shards) != 2 {
		t.Fatalf("got %d shards, want 2", len(normalized.Shards))
	}
	if normalized.Shards[0].Sequence != 0 || normalized.Shards[1].Sequence != 1 {
		t.Fatalf("shards not sorted: %+v", normalized.Shards)
	}
}

func TestManifestRejectsConflictingDuplicate(t *testing.T) {
	zero := makeShard(t, 0, "v1", "a")
	other := makeShard(t, 0, "v1", "b")
	m := Manifest{SchemaVersion: "v1", Shards: []Shard{zero.shard, other.shard}}
	if _, err := m.Normalize(); !errors.Is(err, ErrShardConflict) {
		t.Fatalf("error = %v, want ErrShardConflict", err)
	}
}

func TestManifestRejectsSchemaMismatch(t *testing.T) {
	zero := makeShard(t, 0, "v2", "a")
	m := Manifest{SchemaVersion: "v1", Shards: []Shard{zero.shard}}
	if _, err := m.Normalize(); !errors.Is(err, ErrSchemaMismatch) {
		t.Fatalf("error = %v, want ErrSchemaMismatch", err)
	}
}

func TestManifestFillsGlobalSchemaVersion(t *testing.T) {
	zero := makeShard(t, 0, "v1", "a")
	m := Manifest{Shards: []Shard{zero.shard}}
	normalized, err := m.Normalize()
	if err != nil {
		t.Fatal(err)
	}
	if normalized.SchemaVersion != "v1" || normalized.Shards[0].SchemaVersion != "v1" {
		t.Fatalf("schema not propagated: %+v", normalized)
	}
}

func TestManifestGaps(t *testing.T) {
	m := Manifest{
		SchemaVersion: "v1",
		Shards: []Shard{
			{Sequence: 0, Digest: SHA256Digest([]byte("a")), LineCount: 1, SchemaVersion: "v1"},
			{Sequence: 2, Digest: SHA256Digest([]byte("b")), LineCount: 1, SchemaVersion: "v1"},
			{Sequence: 5, Digest: SHA256Digest([]byte("c")), LineCount: 1, SchemaVersion: "v1"},
		},
	}
	got := m.MissingSequences()
	want := []int64{1, 3, 4}
	if len(got) != len(want) {
		t.Fatalf("MissingSequences = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("MissingSequences = %v, want %v", got, want)
		}
	}
}

func TestParseManifest(t *testing.T) {
	payload := SHA256Digest([]byte("x"))
	doc := `{"schema_version":"v1","shards":[{"sequence":0,"digest":"` + payload + `","line_count":1}]}`
	m, err := ParseManifest(strings.NewReader(doc))
	if err != nil {
		t.Fatal(err)
	}
	if m.SchemaVersion != "v1" || len(m.Shards) != 1 || m.Shards[0].SchemaVersion != "v1" {
		t.Fatalf("unexpected manifest: %+v", m)
	}
	if _, err := ParseManifest(strings.NewReader(doc + `{}`)); !errors.Is(err, ErrInvalidManifest) {
		t.Fatalf("trailing JSON error = %v", err)
	}
}
