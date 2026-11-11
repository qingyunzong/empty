package q197

import (
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func testRegistry() *Registry {
	r := NewRegistry()
	r.AddContext("base", RawContext{
		"@vocab": "https://example.org/vocab/",
		"name":   "https://schema.org/name",
		"id":     "https://schema.org/identifier",
	})
	r.AddContext("aliases", RawContext{
		"@include": "base",
		"title":    "name", // 前向别名：name 来自被包含的 base
		"label":    "title",
		"loopA":    "loopB",
		"loopB":    "loopA",
	})
	r.AddContext("override", RawContext{
		"@include": "base",
		"name":     nil, // null 删除继承词项
		"name2": RawContext{
			"@id":      "https://schema.org/alternateName",
			"@context": "nested",
		},
	})
	r.AddContext("nested", RawContext{
		"@include": "base",
		"name":     "https://nested.example/name",
	})
	r.AddContext("shared", RawContext{
		"sharedTerm": "leaf",
	})
	r.AddContext("ringA", RawContext{
		"@include": "shared",
		"alpha":    "sharedTerm",
	})
	r.AddContext("ringB", RawContext{
		"@include": "shared",
		"leaf":     "sharedTerm", // sharedTerm -> leaf -> sharedTerm，经共享上下文成环
	})
	r.AddContext("cyc1", RawContext{"@include": "cyc2"})
	r.AddContext("cyc2", RawContext{"@include": "cyc1"})
	r.AddContext("noVocab", RawContext{
		"@include": "base",
		"@vocab":   nil,
	})
	return r
}

func TestBasicMappingAndVocab(t *testing.T) {
	r := testRegistry()
	input := map[string]any{
		"name": "Alice",
		"id":   42,
		"plain": map[string]any{
			"keep": "string-value",
		},
		"list": []any{"b", "a", "c"},
	}
	got, err := r.Expand("base", input)
	if err != nil {
		t.Fatalf("Expand returned error: %v", err)
	}
	want := map[string]any{
		"https://schema.org/name":       "Alice",
		"https://schema.org/identifier": 42,
		"https://example.org/vocab/plain": map[string]any{
			"https://example.org/vocab/keep": "string-value",
		},
		"https://example.org/vocab/list": []any{"b", "a", "c"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("Expand mismatch\n got: %#v\nwant: %#v", got, want)
	}

	if _, err := r.Expand("noVocab", map[string]any{"unknown": "x"}); !errors.Is(err, ErrUnknownTerm) {
		t.Fatalf("expected ErrUnknownTerm without vocab, got %v", err)
	}
}

func TestForwardAliasesResolveRecursively(t *testing.T) {
	r := testRegistry()
	scope, err := r.Compile("aliases", nil)
	if err != nil {
		t.Fatalf("Compile aliases: %v", err)
	}
	cases := map[string]string{
		"title": "https://schema.org/name",
		"label": "https://schema.org/name",
		"name":  "https://schema.org/name",
	}
	for term, want := range cases {
		got, err := scope.Resolve(term)
		if err != nil {
			t.Fatalf("Resolve(%q): %v", term, err)
		}
		if got != want {
			t.Fatalf("Resolve(%q) = %q, want %q", term, got, want)
		}
	}
}

func TestAliasCycleReportsFullChain(t *testing.T) {
	r := testRegistry()
	scope, err := r.Compile("aliases", nil)
	if err != nil {
		t.Fatalf("Compile aliases: %v", err)
	}
	_, err = scope.Resolve("loopA")
	if !errors.Is(err, ErrAliasCycle) {
		t.Fatalf("expected ErrAliasCycle, got %v", err)
	}
	if !strings.Contains(err.Error(), "loopA -> loopB -> loopA") {
		t.Fatalf("error must contain full cycle chain, got %v", err)
	}
}

func TestNullDeletesAndRedefineInChild(t *testing.T) {
	r := testRegistry()
	override, err := r.Compile("override", nil)
	if err != nil {
		t.Fatalf("Compile override: %v", err)
	}
	if _, err := override.Resolve("name"); !errors.Is(err, ErrTermDeleted) {
		t.Fatalf("deleted term should report ErrTermDeleted, got %v", err)
	}

	nested, err := r.Compile("nested", override)
	if err != nil {
		t.Fatalf("Compile nested: %v", err)
	}
	got, err := nested.Resolve("name")
	if err != nil {
		t.Fatalf("redefined term should resolve, got %v", err)
	}
	if want := "https://nested.example/name"; got != want {
		t.Fatalf("Resolve(name) = %q, want %q", got, want)
	}

	// 父作用域保持不可变，删除状态不受子作用域重定义影响。
	if _, err := override.Resolve("name"); !errors.Is(err, ErrTermDeleted) {
		t.Fatalf("parent scope mutated by child scope: %v", err)
	}
}

func TestSharedContextCycleThroughParents(t *testing.T) {
	r := testRegistry()
	// ringA 与 ringB 都包含 shared；在 ringA 之上编译 ringB 后，
	// ringB 的本地定义把 leaf 指回 shared 中的 sharedTerm，形成环。
	ringA, err := r.Compile("ringA", nil)
	if err != nil {
		t.Fatalf("Compile ringA: %v", err)
	}
	ringB, err := r.Compile("ringB", ringA)
	if err != nil {
		t.Fatalf("Compile ringB: %v", err)
	}
	_, err = ringB.Resolve("sharedTerm")
	if !errors.Is(err, ErrAliasCycle) {
		t.Fatalf("expected ErrAliasCycle via shared context, got %v", err)
	}
	if !strings.Contains(err.Error(), "sharedTerm -> leaf -> sharedTerm") {
		t.Fatalf("error must contain full shared-context chain, got %v", err)
	}
}

func TestKeyConflictRejectsWholeObject(t *testing.T) {
	r := testRegistry()
	input := map[string]any{
		"name":  "first",
		"title": "second", // 别名展开后与 name 同一 IRI
	}
	_, err := r.Expand("aliases", input)
	if !errors.Is(err, ErrKeyConflict) {
		t.Fatalf("expected ErrKeyConflict, got %v", err)
	}

	// 绝对 IRI 键与词项键冲突同样拒绝，且输入对象不被修改。
	iriKey := "https://schema.org/name"
	withIRI := map[string]any{iriKey: "x", "name": "y"}
	if _, err := r.Expand("base", withIRI); !errors.Is(err, ErrKeyConflict) {
		t.Fatalf("expected ErrKeyConflict for IRI key, got %v", err)
	}
	if len(withIRI) != 2 || withIRI[iriKey] != "x" || withIRI["name"] != "y" {
		t.Fatalf("input object was mutated: %#v", withIRI)
	}
}

func TestArrayOrderAndStringsPreserved(t *testing.T) {
	r := testRegistry()
	input := map[string]any{
		"list": []any{
			map[string]any{"name": "one"},
			"raw-string",
			[]any{3, 2, 1},
			nil,
			true,
		},
	}
	got, err := r.Expand("base", input)
	if err != nil {
		t.Fatalf("Expand: %v", err)
	}
	want := map[string]any{
		"https://example.org/vocab/list": []any{
			map[string]any{"https://schema.org/name": "one"},
			"raw-string",
			[]any{3, 2, 1},
			nil,
			true,
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("array/scalar mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestImmutableScopeCacheReuseAcrossParents(t *testing.T) {
	r := testRegistry()
	root1, err := r.Compile("base", nil)
	if err != nil {
		t.Fatalf("Compile base root: %v", err)
	}
	root2, err := r.Compile("nested", nil)
	if err != nil {
		t.Fatalf("Compile nested root: %v", err)
	}

	sharedUnder1, err := r.Compile("shared", root1)
	if err != nil {
		t.Fatalf("Compile shared under root1: %v", err)
	}
	sharedUnder1Again, err := r.Compile("shared", root1)
	if err != nil {
		t.Fatalf("Compile shared under root1 again: %v", err)
	}
	sharedUnder2, err := r.Compile("shared", root2)
	if err != nil {
		t.Fatalf("Compile shared under root2: %v", err)
	}

	if sharedUnder1 != sharedUnder1Again {
		t.Fatal("same (parent, context) must return cached identical scope")
	}
	if sharedUnder1 == sharedUnder2 {
		t.Fatal("same context under different parents must compile separate scopes")
	}
	if sharedUnder1.Parent() != root1 || sharedUnder2.Parent() != root2 {
		t.Fatal("cached scopes must retain their distinct parents")
	}

	// 缓存命中在并发编译下也应稳定返回同一指针。
	var wg sync.WaitGroup
	results := make([]*Scope, 8)
	for i := range results {
		wg.Add(1)
		go func(index int) {
			defer wg.Done()
			scope, err := r.Compile("shared", root1)
			if err != nil {
				t.Errorf("concurrent Compile: %v", err)
				return
			}
			results[index] = scope
		}(i)
	}
	wg.Wait()
	for _, scope := range results {
		if scope != sharedUnder1 {
			t.Fatal("concurrent Compile returned inconsistent cached scope")
		}
	}
}

func TestScopedContextOverrideOnProperty(t *testing.T) {
	r := testRegistry()
	input := map[string]any{
		"name": "outer",
		"name2": map[string]any{
			"name": "inner",
		},
	}
	got, err := r.Expand("override", input)
	if err != nil {
		t.Fatalf("Expand: %v", err)
	}
	want := map[string]any{
		// override 中 name 被删除，回退到 @vocab。
		"https://example.org/vocab/name": "outer",
		"https://schema.org/alternateName": map[string]any{
			"https://nested.example/name": "inner",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("scoped context mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestIncludeCycleReportsFullChain(t *testing.T) {
	r := testRegistry()
	_, err := r.Compile("cyc1", nil)
	if !errors.Is(err, ErrIncludeCycle) {
		t.Fatalf("expected ErrIncludeCycle, got %v", err)
	}
	if !strings.Contains(err.Error(), "cyc1 -> cyc2 -> cyc1") {
		t.Fatalf("include cycle error must contain full chain, got %v", err)
	}
}

func TestVocabNullRemovesInheritedVocab(t *testing.T) {
	r := testRegistry()
	base, err := r.Compile("base", nil)
	if err != nil {
		t.Fatalf("Compile base: %v", err)
	}
	if !base.hasVocab {
		t.Fatal("base scope should carry a vocab prefix")
	}
	noVocab, err := r.Compile("noVocab", nil)
	if err != nil {
		t.Fatalf("Compile noVocab: %v", err)
	}
	if noVocab.hasVocab {
		t.Fatal("null @vocab must remove inherited vocab prefix")
	}
	got, err := r.Expand("noVocab", map[string]any{"id": "x"})
	if err != nil {
		t.Fatalf("mapped term should still expand without vocab: %v", err)
	}
	want := map[string]any{"https://schema.org/identifier": "x"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("vocab-null mismatch\n got: %#v\nwant: %#v", got, want)
	}
}

func TestUnknownContextAndTermErrors(t *testing.T) {
	r := testRegistry()
	if _, err := r.Compile("missing", nil); !errors.Is(err, ErrUnknownContext) {
		t.Fatalf("expected ErrUnknownContext, got %v", err)
	}
	if _, err := r.Expand("missing", map[string]any{"name": "x"}); !errors.Is(err, ErrUnknownContext) {
		t.Fatalf("Expand with unknown root context: %v", err)
	}
	scope, err := r.Compile("base", nil)
	if err != nil {
		t.Fatalf("Compile base: %v", err)
	}
	if _, err := scope.Resolve("missing-term"); !errors.Is(err, ErrUnknownTerm) {
		t.Fatalf("expected ErrUnknownTerm, got %v", err)
	}
}
