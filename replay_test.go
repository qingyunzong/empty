package dataeng

import (
	"errors"
	"reflect"
	"testing"
)

func testSchemaFixture() SchemaMessage {
	return NewSchema(
		Column{Name: "id", Type: TypeInt},
		Column{Name: "tag", Type: TypeString, DictionaryID: "d"},
	)
}

func testDict(id string, generation int, mode DictionaryMode, values ...any) DictionaryMessage {
	return NewDictionary(id, generation, mode, values...)
}

func testBatch(generations map[string]int, columns ...ColumnBatch) BatchMessage {
	return NewBatch(generations, columns...)
}

func testFeed(t *testing.T, stream *Stream, message any) []Result {
	t.Helper()
	results, err := stream.Feed(message)
	if err != nil {
		t.Fatalf("Feed: %v", err)
	}
	return results
}

func testValues(t *testing.T, result Result, column string) []any {
	t.Helper()
	got, ok := result.Values(column)
	if !ok {
		t.Fatalf("missing column %q", column)
	}
	return got
}

func TestMismatchedColumnsFailLocally(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	results := testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a", "b"))
	if len(results) != 0 {
		t.Fatalf("dictionary should not emit a batch: %d", len(results))
	}
	results, err := stream.Feed(testBatch(map[string]int{"d": 1},
		NewColumnBatch("id", []int{1, 2}),
		NewColumnBatch("tag", []int{0, 1, -1}),
	))
	// id has two rows while tag has three: this batch must fail locally.
	if !errors.Is(err, ErrColumnLength) || len(results) != 0 {
		t.Fatalf("mismatched batch: results=%d err=%v", len(results), err)
	}
}

func TestDecodeAndNull(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a", "b"))
	results := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("id", []int{1, 2, 3}),
		NewColumnBatch("tag", []int{0, 1, -1}),
	))
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"a", "b", nil}) {
		t.Fatalf("tag = %#v", got)
	}
	if got := testValues(t, results[0], "id"); !reflect.DeepEqual(got, []any{1, 2, 3}) {
		t.Fatalf("id = %#v", got)
	}
}

func TestBatchBeforeDictionary(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	results := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{0}),
	))
	if len(results) != 0 || stream.Pending() != 1 {
		t.Fatalf("batch should wait for generation 1")
	}
	results = testFeed(t, stream, testDict("d", 1, DictionaryReplace, "late"))
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"late"}) {
		t.Fatalf("tag = %#v", got)
	}
}

func TestMissingGenerationBuffered(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a"))
	testFeed(t, stream, testDict("d", 3, DictionaryAppend, "c")) // held until 2 arrives
	results := testFeed(t, stream, testBatch(map[string]int{"d": 3},
		NewColumnBatch("tag", []int{2}),
	))
	if len(results) != 0 {
		t.Fatalf("batch must wait for generation 3")
	}
	results = testFeed(t, stream, testDict("d", 2, DictionaryAppend, "b"))
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"c"}) {
		t.Fatalf("tag = %#v", got)
	}
	if err := stream.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
}

func TestReplaceKeepsOldViewAndReusesIndices(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a", "b"))
	first := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{0, 1}),
	))
	testFeed(t, stream, testDict("d", 2, DictionaryReplace, "x", "y"))
	second := testFeed(t, stream, testBatch(map[string]int{"d": 2},
		NewColumnBatch("tag", []int{0, 1}),
	))
	oldAgain := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{1, 0}),
	))
	if got := testValues(t, first[0], "tag"); !reflect.DeepEqual(got, []any{"a", "b"}) {
		t.Fatalf("first = %#v", got)
	}
	if got := testValues(t, second[0], "tag"); !reflect.DeepEqual(got, []any{"x", "y"}) {
		t.Fatalf("second = %#v", got)
	}
	if got := testValues(t, oldAgain[0], "tag"); !reflect.DeepEqual(got, []any{"b", "a"}) {
		t.Fatalf("old view = %#v", got)
	}
	// A later replacement must not rewrite results already returned.
	if got := testValues(t, first[0], "tag"); !reflect.DeepEqual(got, []any{"a", "b"}) {
		t.Fatalf("first changed after replacement: %#v", got)
	}
}

func TestAppendBuildsOnPreviousAndNeverChangesOldItems(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a"))
	old := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{0}),
	))
	testFeed(t, stream, testDict("d", 2, DictionaryAppend, "b", "c"))
	all := testFeed(t, stream, testBatch(map[string]int{"d": 2},
		NewColumnBatch("tag", []int{0, 1, 2}),
	))
	if got := testValues(t, old[0], "tag"); !reflect.DeepEqual(got, []any{"a"}) {
		t.Fatalf("old = %#v", got)
	}
	if got := testValues(t, all[0], "tag"); !reflect.DeepEqual(got, []any{"a", "b", "c"}) {
		t.Fatalf("all = %#v", got)
	}
	if got := testValues(t, old[0], "tag"); !reflect.DeepEqual(got, []any{"a"}) {
		t.Fatalf("old changed after append: %#v", got)
	}
}

func TestInterleavedColumnBatchesAndMultipleDictionaries(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, NewSchema(
		Column{Name: "left", Type: TypeString, DictionaryID: "dl"},
		Column{Name: "n", Type: TypeInt},
		Column{Name: "right", Type: TypeString, DictionaryID: "dr"},
	))
	testFeed(t, stream, testDict("dr", 1, DictionaryReplace, "R1", "R2"))
	testFeed(t, stream, testDict("dl", 1, DictionaryReplace, "L1", "L2"))
	results := testFeed(t, stream, testBatch(map[string]int{"dr": 1, "dl": 1},
		ColumnBatch{Name: "right", Indices: []int{1, 0}},
		ColumnBatch{Name: "n", Values: []int{7, 8}},
		ColumnBatch{Name: "left", Indices: []int64{0, 1}},
	))
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	if got := testValues(t, results[0], "left"); !reflect.DeepEqual(got, []any{"L1", "L2"}) {
		t.Fatalf("left = %#v", got)
	}
	if got := testValues(t, results[0], "right"); !reflect.DeepEqual(got, []any{"R2", "R1"}) {
		t.Fatalf("right = %#v", got)
	}
	if got := testValues(t, results[0], "n"); !reflect.DeepEqual(got, []any{7, 8}) {
		t.Fatalf("n = %#v", got)
	}
}

func TestInvalidIndexFailsOnlyBatch(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a", "b"))
	results, err := stream.Feed(testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{2}),
	))
	if !errors.Is(err, ErrInvalidIndex) {
		t.Fatalf("err = %v, want invalid index", err)
	}
	if len(results) != 0 {
		t.Fatalf("invalid batch emitted results")
	}
	results = testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{0}),
	))
	if len(results) != 1 {
		t.Fatalf("dictionary was polluted by invalid batch")
	}
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"a"}) {
		t.Fatalf("tag = %#v", got)
	}
	results, err = stream.Feed(testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{-2}),
	))
	if !errors.Is(err, ErrInvalidIndex) || len(results) != 0 {
		t.Fatalf("negative index err = %v, results = %d", err, len(results))
	}
}

func TestRedeliveryIsIdempotentButDifferentContentRejected(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a", "b"))
	if err := stream.Apply(testDict("d", 1, DictionaryReplace, "a", "b")); err != nil {
		t.Fatalf("same redelivery: %v", err)
	}
	err := stream.Apply(testDict("d", 1, DictionaryReplace, "a", "x"))
	if !errors.Is(err, ErrInvalidGeneration) && err == nil {
		t.Fatalf("different redelivery was accepted: %v", err)
	}
	var conflict *GenerationConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("err = %v, want GenerationConflictError", err)
	}
	results := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{0, 1}),
	))
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"a", "b"}) {
		t.Fatalf("dictionary was corrupted: %#v", got)
	}
}

func TestAppendRedeliveryDoesNotDuplicate(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a"))
	testFeed(t, stream, testDict("d", 2, DictionaryAppend, "b"))
	if err := stream.Apply(testDict("d", 2, DictionaryAppend, "b")); err != nil {
		t.Fatalf("same append redelivery: %v", err)
	}
	results := testFeed(t, stream, testBatch(map[string]int{"d": 2},
		NewColumnBatch("tag", []int{0, 1}),
	))
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"a", "b"}) {
		t.Fatalf("append duplicated: %#v", got)
	}
}

func TestStrictArrivalOrderAndClosePending(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	// First batch waits for d:2, so the later d:1 batch is held back.
	testFeed(t, stream, testBatch(map[string]int{"d": 2},
		NewColumnBatch("tag", []int{0}),
	))
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a"))
	if got := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{0}),
	)); len(got) != 0 {
		t.Fatalf("later batch should not jump the queue")
	}
	if err := stream.Close(); err == nil {
		t.Fatal("Close should report pending batches")
	}
}

func TestEmptyReplacementGeneration(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace))
	// An empty dictionary is a real frozen generation; index 0 is invalid but
	// a zero-row batch must decode successfully.
	results := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{}),
	))
	if len(results) != 1 {
		t.Fatalf("empty generation was mistaken for a missing one")
	}
}

func TestJSONMessageDecoding(t *testing.T) {
	stream := NewStream()
	jsonMessages := []string{
		`{"type":"schema","columns":[{"name":"tag","type":"string","dictionary_id":"d"}]}`,
		`{"type":"batch","generations":{"d":1},"columns":[{"name":"tag","indices":[0,1,2]}]}`,
		`{"type":"dictionary","id":"d","generation":1,"mode":"replace","values":["x","y","z"]}`,
	}
	for _, message := range jsonMessages {
		results, err := stream.Feed(message)
		if err != nil {
			t.Fatalf("Feed %s: %v", message, err)
		}
		if len(results) > 0 {
			if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"x", "y", "z"}) {
				t.Fatalf("tag = %#v", got)
			}
		}
	}
}

func TestReplayHelper(t *testing.T) {
	messages := []any{
		testSchemaFixture(),
		testBatch(map[string]int{"d": 1}, NewColumnBatch("tag", []int{0})),
		testDict("d", 1, DictionaryReplace, "a"),
	}
	results, err := Replay(messages...)
	if err != nil {
		t.Fatalf("Replay: %v", err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results", len(results))
	}
}

func TestPerDictionaryGenerationsWithLateUpdate(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, NewSchema(
		Column{Name: "left", Type: TypeString, DictionaryID: "dl"},
		Column{Name: "right", Type: TypeString, DictionaryID: "dr"},
	))
	testFeed(t, stream, testDict("dl", 1, DictionaryReplace, "L1"))
	testFeed(t, stream, testDict("dr", 1, DictionaryReplace, "R1"))
	testFeed(t, stream, testDict("dl", 2, DictionaryAppend, "L2"))
	testFeed(t, stream, testDict("dr", 2, DictionaryAppend, "R2"))
	results := testFeed(t, stream, testBatch(map[string]int{"dl": 1, "dr": 2},
		NewColumnBatch("left", []int{0}),
		NewColumnBatch("right", []int{1}),
	))
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	if got := testValues(t, results[0], "left"); !reflect.DeepEqual(got, []any{"L1"}) {
		t.Fatalf("left = %#v", got)
	}
	if got := testValues(t, results[0], "right"); !reflect.DeepEqual(got, []any{"R2"}) {
		t.Fatalf("right = %#v", got)
	}
}

func TestInvalidIndexInDeferredBatchDoesNotCorruptDictionary(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	results, err := stream.Feed(testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{7}),
	))
	if err != nil || len(results) != 0 {
		t.Fatalf("deferred batch should not fail yet: results=%d err=%v", len(results), err)
	}
	results, err = stream.Feed(testDict("d", 1, DictionaryReplace, "a"))
	if !errors.Is(err, ErrInvalidIndex) || len(results) != 0 {
		t.Fatalf("deferred invalid batch: results=%d err=%v", len(results), err)
	}
	if snapshot, ok := stream.DictionarySnapshot("d", 1); !ok || !reflect.DeepEqual(snapshot, []any{"a"}) {
		t.Fatalf("dictionary snapshot = %#v, %v", snapshot, ok)
	}
	results = testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{0}),
	))
	if len(results) != 1 {
		t.Fatal("dictionary was polluted")
	}
}

func TestSchemaRules(t *testing.T) {
	stream := NewStream()
	if err := stream.Apply(testDict("d", 1, DictionaryReplace, "a")); !errors.Is(err, ErrSchemaRequired) {
		t.Fatalf("dictionary before schema: %v", err)
	}
	if err := stream.Apply(testSchemaFixture()); err != nil {
		t.Fatalf("schema: %v", err)
	}
	if err := stream.Apply(testSchemaFixture()); !errors.Is(err, ErrSchemaAlreadySet) {
		t.Fatalf("second schema: %v", err)
	}
	if err := stream.Apply(testDict("other", 1, DictionaryReplace, "a")); !errors.Is(err, ErrUnknownDictionary) {
		t.Fatalf("undeclared dictionary: %v", err)
	}
}

func TestReplayContinuesAfterInvalidBatch(t *testing.T) {
	messages := []any{
		testSchemaFixture(),
		testDict("d", 1, DictionaryReplace, "a", "b"),
		testBatch(map[string]int{"d": 1}, NewColumnBatch("tag", []int{9})),
		testBatch(map[string]int{"d": 1}, NewColumnBatch("tag", []int{1})),
	}
	results, err := Replay(messages)
	if !errors.Is(err, ErrInvalidIndex) {
		t.Fatalf("err = %v, want invalid index", err)
	}
	if len(results) != 1 {
		t.Fatalf("got %d results, want the valid batch", len(results))
	}
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"b"}) {
		t.Fatalf("tag = %#v", got)
	}
}

func TestCloseReportsMissingDictionaryOnly(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a"))
	testFeed(t, stream, testDict("d", 3, DictionaryAppend, "c"))
	err := stream.Close()
	var missing *MissingGenerationError
	if !errors.As(err, &missing) || missing.Generation != 2 {
		t.Fatalf("Close = %v, want missing generation 2", err)
	}
}

func TestSnapshotCannotBeMutatedThroughAccessor(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a"))
	snapshot, ok := stream.DictionarySnapshot("d", 1)
	if !ok {
		t.Fatal("missing snapshot")
	}
	snapshot[0] = "changed"
	results := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		NewColumnBatch("tag", []int{0}),
	))
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"a"}) {
		t.Fatalf("snapshot mutated through accessor: %#v", got)
	}
}

func TestBatchWaitsForAllReferencedGenerations(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, NewSchema(
		Column{Name: "left", Type: TypeString, DictionaryID: "dl"},
		Column{Name: "right", Type: TypeString, DictionaryID: "dr"},
	))
	testFeed(t, stream, testDict("dl", 1, DictionaryReplace, "L1"))
	testFeed(t, stream, testDict("dr", 1, DictionaryReplace, "R1"))
	results := testFeed(t, stream, testBatch(map[string]int{"dl": 1, "dr": 2},
		NewColumnBatch("left", []int{0}),
		NewColumnBatch("right", []int{1}),
	))
	if len(results) != 0 || stream.Pending() != 1 {
		t.Fatalf("batch emitted before every referenced generation was frozen")
	}
	results = testFeed(t, stream, testDict("dr", 2, DictionaryAppend, "R2"))
	if len(results) != 1 {
		t.Fatalf("got %d results, want 1", len(results))
	}
	if got := testValues(t, results[0], "right"); !reflect.DeepEqual(got, []any{"R2"}) {
		t.Fatalf("right = %#v", got)
	}
	if got := testValues(t, results[0], "left"); !reflect.DeepEqual(got, []any{"L1"}) {
		t.Fatalf("left = %#v", got)
	}
}

func TestPerColumnGenerationDeclaration(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a"))
	testFeed(t, stream, testDict("d", 2, DictionaryAppend, "b"))
	results := testFeed(t, stream, testBatch(nil,
		ColumnBatch{Name: "tag", Generation: 1, Indices: []int{0}},
	))
	if len(results) != 1 {
		t.Fatalf("got %d results", len(results))
	}
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"a"}) {
		t.Fatalf("tag = %#v", got)
	}
}

func TestQueuedBatchTakesOwnershipOfInput(t *testing.T) {
	stream := NewStream()
	testFeed(t, stream, testSchemaFixture())
	indices := []int{0}
	results := testFeed(t, stream, testBatch(map[string]int{"d": 1},
		ColumnBatch{Name: "tag", Indices: indices},
	))
	if len(results) != 0 {
		t.Fatal("batch should be queued")
	}
	indices[0] = 9
	results = testFeed(t, stream, testDict("d", 1, DictionaryReplace, "a"))
	if len(results) != 1 {
		t.Fatalf("got %d results", len(results))
	}
	if got := testValues(t, results[0], "tag"); !reflect.DeepEqual(got, []any{"a"}) {
		t.Fatalf("queued indices were not frozen: %#v", got)
	}
}
