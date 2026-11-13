package dataeng

import (
	"testing"
	"time"
)

func testBlock(id, path, text string) Block {
	return Block{ID: id, Path: path, Text: text}
}

func snapshot(blocks ...Block) Snapshot {
	return Snapshot{Blocks: blocks}
}

func kinds(events []Event) map[ChangeKind]int {
	out := make(map[ChangeKind]int)
	for _, event := range events {
		out[event.Kind]++
	}
	return out
}

func TestAddDeleteModifyAndEvidence(t *testing.T) {
	published := time.Date(2026, 11, 13, 8, 0, 0, 0, time.UTC)
	old := snapshot(
		Block{ID: "a", Path: "article>p[1]", Text: "first"},
		Block{ID: "b", Path: "article>p[2]", Text: "second"},
		Block{ID: "c", Path: "article>p[3]", Text: "third"},
	)
	new := snapshot(
		Block{
			ID: "a", Path: "article>p[1]", Text: "first, revised",
			PublishedAt: published,
			PublishEvidence: []PublishEvidence{{
				PublishedAt: published,
				Source:      "meta:article:published_time",
				Confidence:  0.9,
			}},
		},
		Block{ID: "b", Path: "article>p[2]", Text: "second"},
		Block{ID: "d", Path: "article>p[4]", Text: "fourth"},
	)

	result := Diff(old, new)
	if got := kinds(result.Events); got[EventModify] != 1 || got[EventDelete] != 1 || got[EventAdd] != 1 {
		t.Fatalf("unexpected events: %#v (%#v)", got, result.Events)
	}
	modify := result.EventsOfKind(EventModify)[0]
	if modify.Old == nil || modify.New == nil {
		t.Fatal("modify event must carry both versions")
	}
	if modify.New.PublishedAt != published {
		t.Errorf("publish evidence was not retained: %v", modify.New.PublishedAt)
	}
}

func TestAdvertisementAndNavigationChangesAreIgnored(t *testing.T) {
	old := snapshot(
		Block{ID: "a", Path: "article>p[1]", Text: "body one"},
		Block{ID: "nav", Kind: KindNavigation, Path: "aside>nav[1]", Text: "home"},
		Block{ID: "b", Path: "article>p[2]", Text: "body two"},
		Block{ID: "ad", Kind: KindAdvertisement, Path: "aside>div.ad[1]", Text: "buy"},
	)
	new := snapshot(
		Block{ID: "ad2", Kind: KindAdvertisement, Path: "article>div.ad[1]", Text: "new ad"},
		Block{ID: "a", Path: "article>p[2]", Text: "body one"},
		Block{ID: "nav2", Kind: KindNavigation, Path: "header>nav[1]", Text: "menu"},
		Block{ID: "b", Path: "article>p[3]", Text: "body two"},
	)

	result := Diff(old, new)
	if len(result.Events) != 0 {
		t.Fatalf("ad/navigation movement produced body events: %#v", result.Events)
	}
}

func TestDOMIndexShiftFromAdvertisementDoesNotHideModify(t *testing.T) {
	old := snapshot(
		Block{Path: "article>p[1]", Text: "alpha beta gamma"},
	)
	new := snapshot(
		Block{Kind: KindAdvertisement, Path: "article>div[1]", Text: "ad"},
		Block{Path: "article>p[2]", Text: "delta epsilon zeta"},
	)
	result := Diff(old, new)
	if got := kinds(result.Events); got[EventModify] != 1 || len(result.Events) != 1 {
		t.Fatalf("expected one modify after ad shifted the paragraph index, got %#v", result.Events)
	}
}

func TestReorderIsSeparateFromContentChange(t *testing.T) {
	old := snapshot(
		Block{ID: "a", Path: "article>p[1]", Text: "alpha"},
		Block{ID: "b", Path: "article>p[2]", Text: "beta"},
	)
	new := snapshot(
		Block{ID: "b", Path: "article>p[1]", Text: "beta"},
		Block{ID: "a", Path: "article>p[2]", Text: "alpha revised"},
	)
	result := Diff(old, new)
	if len(result.ContentChanges()) != 1 || result.ContentChanges()[0].Kind != EventModify {
		t.Fatalf("expected exactly one content modify: %#v", result.Events)
	}
	if len(result.OrderChanges()) != 1 || result.OrderChanges()[0].Kind != EventReorder {
		t.Fatalf("expected exactly one order event: %#v", result.Events)
	}
	if result.OrderChanges()[0].ContentChanged {
		t.Fatal("order event must not be marked as a content change")
	}
}

func TestPureMoveEmitsNoModify(t *testing.T) {
	old := snapshot(
		Block{ID: "a", Path: "article>p[1]", Text: "alpha"},
		Block{ID: "b", Path: "article>p[2]", Text: "beta"},
		Block{ID: "c", Path: "article>p[3]", Text: "gamma"},
	)
	new := snapshot(
		Block{ID: "c", Path: "article>p[1]", Text: "gamma"},
		Block{ID: "a", Path: "article>p[2]", Text: "alpha"},
		Block{ID: "b", Path: "article>p[3]", Text: "beta"},
	)
	result := Diff(old, new)
	if len(result.Events) != 1 || result.Events[0].Kind != EventReorder {
		t.Fatalf("pure move must produce one reorder event, got %#v", result.Events)
	}
	if len(result.Events[0].OrderChanges) == 0 {
		t.Fatal("reorder event must describe moved blocks")
	}
}

func TestParagraphSplitPreservesSourceMapping(t *testing.T) {
	old := snapshot(Block{
		ID: "src", Path: "article>p[1]", Text: "Hello world",
		Range: TextSpan{Start: 10, End: 21},
	})
	new := snapshot(
		Block{ID: "left", Path: "article>p[1]", Text: "Hello "},
		Block{ID: "right", Path: "article>p[2]", Text: "world"},
	)
	result := Diff(old, new)
	if len(result.Events) != 1 {
		t.Fatalf("split must be one structural event, got %#v", result.Events)
	}
	event := result.Events[0]
	if event.Kind != EventSplit {
		t.Fatalf("expected split, got %s", event.Kind)
	}
	if len(event.Targets) != 2 || len(event.Mapping) != 2 {
		t.Fatalf("split must map both targets: %#v", event)
	}
	if event.Mapping[0].Sources[0].Start != 0 || event.Mapping[0].Sources[0].End != 5 {
		t.Errorf("first source fragment = %#v", event.Mapping[0].Sources[0])
	}
	if event.Mapping[1].Sources[0].Start != 6 || event.Mapping[1].Sources[0].End != 11 {
		t.Errorf("second source fragment = %#v", event.Mapping[1].Sources[0])
	}
	if event.Mapping[0].Sources[0].Document != (TextSpan{Start: 10, End: 15}) {
		t.Errorf("document mapping = %#v", event.Mapping[0].Sources[0].Document)
	}
}

func TestParagraphMergePreservesSourceMapping(t *testing.T) {
	old := snapshot(
		Block{ID: "left", Path: "article>p[1]", Text: "Hello "},
		Block{ID: "right", Path: "article>p[2]", Text: "world"},
	)
	new := snapshot(Block{
		ID: "merged", Path: "article>p[1]", Text: "Hello world",
	})
	result := Diff(old, new)
	if len(result.Events) != 1 || result.Events[0].Kind != EventMerge {
		t.Fatalf("expected one merge, got %#v", result.Events)
	}
	event := result.Events[0]
	if len(event.Sources) != 2 || len(event.Mapping) != 1 || len(event.Mapping[0].Sources) != 2 {
		t.Fatalf("merge provenance is incomplete: %#v", event)
	}
}

func TestGenerationLedgerEmitsEachEventOnce(t *testing.T) {
	old := Snapshot{Generation: "g-1", Blocks: []Block{
		{ID: "a", Text: "before"},
	}}
	new := Snapshot{Generation: "g-1", Blocks: []Block{
		{ID: "a", Text: "after"},
		{ID: "b", Text: "new paragraph"},
	}}
	ledger := NewLedger()
	first := ledger.Diff(old, new)
	if len(first.Events) != 2 {
		t.Fatalf("first generation diff = %#v", first.Events)
	}
	second := ledger.Diff(old, new)
	if len(second.Events) != 0 {
		t.Fatalf("duplicate events were emitted: %#v", second.Events)
	}
}

func TestGenerationScopedEmitter(t *testing.T) {
	generation := NewGeneration("crawl-42")
	old := snapshot(Block{ID: "a", Text: "v1"})
	new := snapshot(Block{ID: "a", Text: "v2"})
	if events := generation.Diff(old, new).Events; len(events) != 1 {
		t.Fatalf("first diff: %#v", events)
	}
	if events := generation.Diff(old, new).Events; len(events) != 0 {
		t.Fatalf("second diff: %#v", events)
	}
	generation.Reset()
	if events := generation.Diff(old, new).Events; len(events) != 1 {
		t.Fatalf("diff after reset: %#v", events)
	}
}

func TestDuplicateBlocksDoNotDuplicateEvents(t *testing.T) {
	duplicate := Block{Path: "article>p[1]", Text: "same"}
	new := snapshot(duplicate, duplicate)
	result := Diff(snapshot(), new)
	if len(result.Events) != 1 || result.Events[0].Kind != EventAdd {
		t.Fatalf("duplicate input produced %#v", result.Events)
	}
}

func TestWhitespaceOnlyChangeIsNotBodyModification(t *testing.T) {
	old := snapshot(Block{Path: "article>p[1]", Text: "hello  world"})
	new := snapshot(Block{Path: "article>p[1]", Text: "hello world"})
	if result := Diff(old, new); len(result.Events) != 0 {
		t.Fatalf("whitespace formatting produced events: %#v", result.Events)
	}
}

func TestDistinctUnidentifiedBlocksKeepDistinctEvents(t *testing.T) {
	new := snapshot(
		Block{Path: "article>p[1]", Text: "alpha"},
		Block{Path: "article>p[2]", Text: "beta"},
	)
	result := Diff(snapshot(), new)
	if len(result.Events) != 2 {
		t.Fatalf("expected two distinct add events, got %#v", result.Events)
	}
	if result.Events[0].ID == result.Events[1].ID {
		t.Fatal("distinct blocks shared an event ID")
	}
}

func TestInsertionDoesNotCreateReorderEvent(t *testing.T) {
	old := snapshot(
		Block{ID: "a", Text: "alpha"},
		Block{ID: "b", Text: "beta"},
	)
	new := snapshot(
		Block{ID: "a", Text: "alpha"},
		Block{ID: "n", Text: "new paragraph"},
		Block{ID: "b", Text: "beta"},
	)
	result := Diff(old, new)
	if len(result.Events) != 1 || result.Events[0].Kind != EventAdd {
		t.Fatalf("insertion produced %#v", result.Events)
	}
}

func TestPublishedTimeChangeAloneIsNotBodyModification(t *testing.T) {
	old := snapshot(Block{
		ID: "a", Text: "same body",
		PublishedAt: time.Date(2026, 11, 13, 1, 0, 0, 0, time.UTC),
	})
	new := snapshot(Block{
		ID: "a", Text: "same body",
		PublishedAt: time.Date(2026, 11, 13, 2, 0, 0, 0, time.UTC),
	})
	if result := Diff(old, new); len(result.Events) != 0 {
		t.Fatalf("metadata-only update produced %#v", result.Events)
	}
}

func TestCJKParagraphSplitAndMerge(t *testing.T) {
	old := snapshot(Block{ID: "src", Text: "你好世界"})
	splitNew := snapshot(
		Block{ID: "a", Text: "你好"},
		Block{ID: "b", Text: "世界"},
	)
	split := Diff(old, splitNew)
	if len(split.Events) != 1 || split.Events[0].Kind != EventSplit {
		t.Fatalf("CJK split = %#v", split.Events)
	}
	if len(split.Events[0].Mapping) != 2 {
		t.Fatalf("CJK split mapping = %#v", split.Events[0].Mapping)
	}

	merge := Diff(splitNew, old)
	if len(merge.Events) != 1 || merge.Events[0].Kind != EventMerge {
		t.Fatalf("CJK merge = %#v", merge.Events)
	}
}

func TestConflictingStableIDsProduceDeleteAndAdd(t *testing.T) {
	old := snapshot(Block{ID: "old", Path: "article>p[1]", Text: "original"})
	new := snapshot(Block{ID: "new", Path: "article>p[1]", Text: "replacement"})
	result := Diff(old, new)
	if got := kinds(result.Events); got[EventDelete] != 1 || got[EventAdd] != 1 || got[EventModify] != 0 {
		t.Fatalf("conflicting IDs = %#v", result.Events)
	}
}

func TestDuplicateGenerationObservationKeepsNewestBlock(t *testing.T) {
	older := Block{
		ID: "p1", Text: "first observation",
		PublishedAt: time.Date(2026, 11, 13, 1, 0, 0, 0, time.UTC),
	}
	newer := Block{
		ID: "p1", Text: "second observation",
		PublishedAt: time.Date(2026, 11, 13, 2, 0, 0, 0, time.UTC),
	}
	result := Diff(snapshot(), snapshot(older, newer))
	if len(result.Events) != 1 || result.Events[0].Kind != EventAdd {
		t.Fatalf("duplicate observations = %#v", result.Events)
	}
	if result.Events[0].New.Text != "second observation" {
		t.Fatalf("newest observation not selected: %#v", result.Events[0].New)
	}
}

func TestMovedAndEditedBlocksWithoutIDs(t *testing.T) {
	old := snapshot(
		Block{Path: "article>p[1]", Text: "the first paragraph has a clear subject"},
		Block{Path: "article>p[2]", Text: "the second paragraph has supporting detail"},
	)
	new := snapshot(
		Block{Path: "article>p[1]", Text: "the second paragraph has supporting details"},
		Block{Path: "article>p[2]", Text: "the first paragraph has a clearer subject"},
	)
	result := Diff(old, new)
	if got := kinds(result.Events); got[EventModify] != 2 || got[EventReorder] != 1 {
		t.Fatalf("moved+edited blocks = %#v", result.Events)
	}
}

func TestManyToManyParagraphRestructureKeepsAllSources(t *testing.T) {
	old := snapshot(
		Block{ID: "a", Text: "ab"},
		Block{ID: "b", Text: "cd"},
	)
	new := snapshot(
		Block{ID: "n1", Text: "abc"},
		Block{ID: "n2", Text: "d"},
	)
	result := Diff(old, new)
	if len(result.Events) != 1 || result.Events[0].Kind != EventSplit {
		t.Fatalf("restructure = %#v", result.Events)
	}
	event := result.Events[0]
	if len(event.Sources) != 2 || len(event.Targets) != 2 || len(event.Mapping) != 2 {
		t.Fatalf("restructure mapping = %#v", event)
	}
	if len(event.Mapping[0].Sources) != 2 {
		t.Fatalf("first target should come from both sources: %#v", event.Mapping[0])
	}
}
