package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func at(sec int64) time.Time {
	return time.Unix(sec, 0).UTC()
}

func TestStagePublishAndViews(t *testing.T) {
	store := NewStore()
	gen := store.Begin()

	first := Page{
		Versions: []ObjectVersion{
			{Key: "a", VersionID: "v2", IsLatest: true, LastModified: at(2), ETag: "e2", Size: 2},
			{Key: "a", VersionID: "v1", LastModified: at(1), ETag: "e1", Size: 1},
			{Key: "b", VersionID: "b1", IsLatest: true, LastModified: at(1), ETag: "eb", Size: 3},
		},
		IsTruncated:         true,
		NextKeyMarker:       "a",
		NextVersionIdMarker: "v1",
	}
	result, err := gen.ApplyPage(first)
	if err != nil {
		t.Fatalf("apply first page: %v", err)
	}
	if result.Added != 3 || result.Duplicates != 0 || result.Complete || !result.MarkerAdvanced {
		t.Fatalf("unexpected first result: %+v", result)
	}
	if got, want := result.Marker, (Marker{KeyMarker: "a", VersionIDMarker: "v1"}); got != want {
		t.Fatalf("marker = %+v, want %+v", got, want)
	}

	// A staging generation must be invisible to readers.
	if got := store.Snapshot().Len(); got != 0 {
		t.Fatalf("staged records leaked into published snapshot: %d", got)
	}

	// Retrying the same page is idempotent and, because its next marker does
	// not move past the current cursor, reports a stalled traversal.
	dup, err := gen.ApplyPage(first)
	if !errors.Is(err, ErrMarkerNotAdvanced) {
		t.Fatalf("duplicate page error = %v, want ErrMarkerNotAdvanced", err)
	}
	if dup.Added != 0 || dup.Duplicates != 3 {
		t.Fatalf("duplicate result = %+v", dup)
	}
	if got := gen.Progress().Records; got != 3 {
		t.Fatalf("records after duplicate = %d, want 3", got)
	}

	last := Page{
		Versions: []ObjectVersion{
			{Key: "a", VersionID: "v3", LastModified: at(3), ETag: "e3", Size: 4},
			{Key: "c", VersionID: "c1", IsLatest: true, LastModified: at(1)},
		},
		DeleteMarkers: []DeleteMarker{
			{Key: "a", VersionID: "v4", IsLatest: true, LastModified: at(4)},
		},
		IsTruncated: false,
	}
	result, err = gen.ApplyPage(last)
	if err != nil {
		t.Fatalf("apply final page: %v", err)
	}
	if !result.Complete || result.Added != 3 {
		t.Fatalf("unexpected final result: %+v", result)
	}
	if err := gen.Publish(); err != nil {
		t.Fatalf("publish: %v", err)
	}

	snapshot := store.Snapshot()
	if snapshot.Number() != 1 {
		t.Fatalf("snapshot number = %d, want 1", snapshot.Number())
	}
	if snapshot.Len() != 6 || snapshot.LatestLen() != 2 {
		t.Fatalf("snapshot sizes: history=%d latest=%d", snapshot.Len(), snapshot.LatestLen())
	}
	if _, ok := snapshot.Latest("a"); ok {
		t.Fatal("key a has a delete marker as latest and must not be live")
	}
	if rec, ok := snapshot.Latest("b"); !ok || rec.VersionID != "b1" {
		t.Fatalf("latest b = %+v, %v", rec, ok)
	}

	history, ok := snapshot.History("a")
	if !ok {
		t.Fatal("history for a missing")
	}
	wantIDs := []string{"v4", "v3", "v2", "v1"}
	if len(history) != len(wantIDs) {
		t.Fatalf("history a length = %d, want %d", len(history), len(wantIDs))
	}
	for i, want := range wantIDs {
		if history[i].VersionID != want {
			t.Fatalf("history a[%d] = %q, want %q", i, history[i].VersionID, want)
		}
		if history[i].IsLatest != (i == 0) {
			t.Fatalf("history a[%d] IsLatest = %v", i, history[i].IsLatest)
		}
	}
	if !history[0].DeleteMarker {
		t.Fatal("newest entry for a must be the delete marker")
	}

	view := snapshot.HistoryView()
	if len(view) != 6 {
		t.Fatalf("history view length = %d", len(view))
	}
	if view[0].Key != "a" || view[len(view)-1].Key != "c" {
		t.Fatalf("history view is not key ordered: first=%q last=%q", view[0].Key, view[len(view)-1].Key)
	}

	// Views are copies.
	view[0].VersionID = "mutated"
	if got, _ := snapshot.History("a"); got[0].VersionID != "v4" {
		t.Fatalf("history view mutation leaked into snapshot: %q", got[0].VersionID)
	}
}

func TestIncompleteTraversalCannotPublish(t *testing.T) {
	store := NewStore()
	gen := store.Begin()
	_, err := gen.ApplyPage(Page{
		Versions:            []ObjectVersion{{Key: "a", VersionID: "v1", IsLatest: true, LastModified: at(1)}},
		IsTruncated:         true,
		NextKeyMarker:       "a",
		NextVersionIDMarker: "v1",
	})
	if err != nil {
		t.Fatalf("apply page: %v", err)
	}
	if err := gen.Publish(); !errors.Is(err, ErrIncompleteTraversal) {
		t.Fatalf("publish incomplete = %v, want ErrIncompleteTraversal", err)
	}
	if store.Snapshot().Len() != 0 {
		t.Fatal("incomplete traversal was published")
	}

	gen.Abort()
	if err := gen.Publish(); !errors.Is(err, ErrGenerationClosed) {
		t.Fatalf("publish aborted = %v, want ErrGenerationClosed", err)
	}
}

func TestFinalPageRetryIsIdempotent(t *testing.T) {
	store := NewStore()
	gen := store.Begin()
	page := Page{
		Versions: []ObjectVersion{
			{Key: "a", VersionID: "v1", IsLatest: true, LastModified: at(1)},
		},
		IsTruncated: false,
	}
	if _, err := gen.ApplyPage(page); err != nil {
		t.Fatalf("apply final page: %v", err)
	}
	result, err := gen.ApplyPage(page)
	if err != nil {
		t.Fatalf("retry final page: %v", err)
	}
	if !result.Complete || result.Added != 0 || result.Duplicates != 1 {
		t.Fatalf("retry result = %+v", result)
	}

	// A final page that introduces another identity cannot extend a sealed
	// traversal.
	_, err = gen.ApplyPage(Page{
		Versions: []ObjectVersion{{Key: "b", VersionID: "v1", LastModified: at(2)}},
	})
	if !errors.Is(err, ErrTraversalComplete) {
		t.Fatalf("extend completed traversal = %v, want ErrTraversalComplete", err)
	}

	if err := gen.Publish(); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if got := store.Snapshot().Len(); got != 1 {
		t.Fatalf("history length = %d, want 1", got)
	}

	_, err = gen.ApplyPage(Page{
		Versions: []ObjectVersion{{Key: "b", VersionID: "v1", LastModified: at(2)}},
	})
	if !errors.Is(err, ErrGenerationClosed) {
		t.Fatalf("apply after publish = %v, want ErrGenerationClosed", err)
	}
}

func TestCollectStopsWhenMarkerDoesNotAdvance(t *testing.T) {
	store := NewStore()
	page := Page{
		Versions:            []ObjectVersion{{Key: "a", VersionID: "v1", IsLatest: true, LastModified: at(1)}},
		IsTruncated:         true,
		NextKeyMarker:       "a",
		NextVersionIDMarker: "v1",
	}
	calls := 0
	_, err := store.Collect(context.Background(), func(context.Context, Marker) (Page, error) {
		calls++
		return page, nil
	})
	if !errors.Is(err, ErrMarkerNotAdvanced) {
		t.Fatalf("collect error = %v, want ErrMarkerNotAdvanced", err)
	}
	if calls != 2 {
		t.Fatalf("fetch calls = %d, want 2", calls)
	}
	if store.Snapshot().Number() != 0 || store.Snapshot().Len() != 0 {
		t.Fatal("stalled traversal published a snapshot")
	}
	if _, ok := store.Progress(); ok {
		t.Fatal("stalled traversal left an active generation")
	}
}

func TestMarkerAdvancesWithinOneKey(t *testing.T) {
	store := NewStore()
	gen := store.Begin()
	_, err := gen.ApplyPage(Page{
		Versions:            []ObjectVersion{{Key: "a", VersionID: "v2", LastModified: at(2)}},
		IsTruncated:         true,
		NextKeyMarker:       "a",
		NextVersionIDMarker: "v2",
	})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	result, err := gen.ApplyPage(Page{
		Versions:            []ObjectVersion{{Key: "a", VersionID: "v1", LastModified: at(1)}},
		IsTruncated:         false,
		NextKeyMarker:       "a",
		NextVersionIDMarker: "v1",
	})
	if err != nil {
		t.Fatalf("final page with regressed marker should still complete: %v", err)
	}
	if !result.Complete {
		t.Fatalf("final result = %+v", result)
	}
	if err := gen.Publish(); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if got := store.Snapshot().Len(); got != 2 {
		t.Fatalf("history length = %d, want 2", got)
	}
}

func TestOverlappingPageIsIdempotentAndAdvances(t *testing.T) {
	store := NewStore()
	gen := store.Begin()
	_, err := gen.ApplyPage(Page{
		Versions: []ObjectVersion{
			{Key: "a", VersionID: "a1", IsLatest: true, LastModified: at(1)},
			{Key: "b", VersionID: "b1", IsLatest: true, LastModified: at(1)},
		},
		IsTruncated:   true,
		NextKeyMarker: "b",
	})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	result, err := gen.ApplyPage(Page{
		Versions: []ObjectVersion{
			{Key: "b", VersionID: "b1", IsLatest: true, LastModified: at(1)},
			{Key: "c", VersionID: "c1", IsLatest: true, LastModified: at(1)},
		},
		IsTruncated:   true,
		NextKeyMarker: "c",
	})
	if err != nil {
		t.Fatalf("overlapping page: %v", err)
	}
	if result.Added != 1 || result.Duplicates != 1 {
		t.Fatalf("overlap result = %+v", result)
	}
	if _, err := gen.ApplyPage(Page{IsTruncated: false}); err != nil {
		t.Fatalf("final page: %v", err)
	}
	if err := gen.Publish(); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if got := store.Snapshot().Len(); got != 3 {
		t.Fatalf("history length = %d, want 3", got)
	}
}

func TestDeleteMarkerOlderThanLiveVersion(t *testing.T) {
	store := NewStore()
	if _, err := store.ApplyPage(Page{
		Versions: []ObjectVersion{
			{Key: "a", VersionID: "v2", IsLatest: true, LastModified: at(3)},
			{Key: "a", VersionID: "v1", LastModified: at(1)},
		},
		DeleteMarkers: []DeleteMarker{
			{Key: "a", VersionID: "d1", LastModified: at(2)},
		},
	}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if err := store.Publish(); err != nil {
		t.Fatalf("publish: %v", err)
	}
	rec, ok := store.Latest("a")
	if !ok || rec.VersionID != "v2" || rec.DeleteMarker {
		t.Fatalf("latest a = %+v, %v", rec, ok)
	}
	history, _ := store.History("a")
	if len(history) != 3 || history[0].VersionID != "v2" || history[1].VersionID != "d1" {
		t.Fatalf("history = %+v", history)
	}
	if entry, ok := store.LatestEntry("a"); !ok || entry.VersionID != "v2" || store.Snapshot().Deleted("a") {
		t.Fatalf("latest entry a = %+v, %v", entry, ok)
	}
	if got := store.Snapshot().LatestEntries(); len(got) != 1 || got[0].Key != "a" {
		t.Fatalf("latest entries = %+v", got)
	}
}

func TestPublishedSnapshotsAreImmutable(t *testing.T) {
	store := NewStore()
	if _, err := store.ApplyPage(Page{
		Versions: []ObjectVersion{{Key: "a", VersionID: "v1", IsLatest: true, LastModified: at(1)}},
	}); err != nil {
		t.Fatalf("first traversal: %v", err)
	}
	if err := store.Publish(); err != nil {
		t.Fatalf("publish first: %v", err)
	}
	first := store.Snapshot()

	if _, err := store.ApplyPage(Page{
		Versions: []ObjectVersion{{Key: "b", VersionID: "v2", IsLatest: true, LastModified: at(2)}},
	}); err != nil {
		t.Fatalf("second traversal: %v", err)
	}
	if err := store.Publish(); err != nil {
		t.Fatalf("publish second: %v", err)
	}
	second := store.Snapshot()

	if first == second {
		t.Fatal("publication did not replace the snapshot pointer")
	}
	if first.Number() != 1 || second.Number() != 2 {
		t.Fatalf("snapshot numbers = %d, %d", first.Number(), second.Number())
	}
	if rec, ok := first.Latest("a"); !ok || rec.VersionID != "v1" {
		t.Fatalf("old snapshot changed: %+v, %v", rec, ok)
	}
	if first.Has("b") {
		t.Fatal("old snapshot gained a record from the new traversal")
	}
	if rec, ok := second.Latest("b"); !ok || rec.VersionID != "v2" {
		t.Fatalf("new snapshot latest b = %+v, %v", rec, ok)
	}
	if second.Has("a") {
		t.Fatal("second complete traversal should replace inventory records not returned by it")
	}
}

func TestCollectMergesConcurrentUploads(t *testing.T) {
	store := NewStore()
	uploads := 0
	snapshot, err := store.Collect(context.Background(), func(_ context.Context, after Marker) (Page, error) {
		switch after {
		case (Marker{}):
			return Page{
				Versions: []ObjectVersion{
					{Key: "early", VersionID: "e1", IsLatest: true, LastModified: at(1)},
				},
				IsTruncated:   true,
				NextKeyMarker: "early",
			}, nil
		case (Marker{KeyMarker: "early"}):
			// The upload arrives after the collector has already paged past
			// "early". It must still be merged at publication, but must not be
			// visible in the old published snapshot while staging is open.
			if err := store.RecordUpload(ObjectVersion{
				Key: "early", VersionID: "e2", LastModified: at(5), ETag: "new", Size: 9,
			}); err != nil {
				return Page{}, err
			}
			uploads++
			if store.Snapshot().Has("early") {
				return Page{}, fmt.Errorf("staged upload leaked before publish")
			}
			return Page{
				Versions: []ObjectVersion{
					{Key: "late", VersionID: "l1", IsLatest: true, LastModified: at(2)},
				},
				IsTruncated: false,
			}, nil
		default:
			return Page{}, fmt.Errorf("unexpected marker %+v", after)
		}
	})
	if err != nil {
		t.Fatalf("collect: %v", err)
	}
	if uploads != 1 {
		t.Fatalf("uploads = %d", uploads)
	}
	rec, ok := snapshot.Latest("early")
	if !ok || rec.VersionID != "e2" || rec.Size != 9 {
		t.Fatalf("latest early = %+v, %v", rec, ok)
	}
	history, _ := snapshot.History("early")
	if len(history) != 2 || history[0].VersionID != "e2" || history[1].VersionID != "e1" {
		t.Fatalf("early history = %+v", history)
	}
	if rec, ok := snapshot.Latest("late"); !ok || rec.VersionID != "l1" {
		t.Fatalf("latest late = %+v, %v", rec, ok)
	}
}

func TestUploadWithoutGenerationIsImmediate(t *testing.T) {
	store := NewStore()
	if err := store.RecordUpload(ObjectVersion{Key: "a", VersionID: "v1", LastModified: at(1)}); err != nil {
		t.Fatalf("upload: %v", err)
	}
	if rec, ok := store.Latest("a"); !ok || rec.VersionID != "v1" {
		t.Fatalf("latest after immediate upload = %+v, %v", rec, ok)
	}

	// A later upload with no timestamp is observed now and becomes latest.
	if err := store.RecordUpload(ObjectVersion{Key: "a", VersionId: "v2"}); err != nil {
		t.Fatalf("second upload: %v", err)
	}
	if rec, ok := store.Latest("a"); !ok || rec.VersionID != "v2" {
		t.Fatalf("latest after second upload = %+v, %v", rec, ok)
	}
}

func TestConcurrentUploadWinsEqualTimestampTie(t *testing.T) {
	store := NewStore()
	if _, err := store.ApplyPage(Page{
		Versions: []ObjectVersion{
			{Key: "a", VersionID: "old", IsLatest: true, LastModified: at(10)},
		},
	}); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if err := store.Publish(); err != nil {
		t.Fatalf("publish: %v", err)
	}
	// The upload is observed later, so it wins even though the timestamp is
	// the same and the older inventory entry still carries IsLatest.
	if err := store.RecordUpload(ObjectVersion{
		Key: "a", VersionID: "new", LastModified: at(10), ETag: "new",
	}); err != nil {
		t.Fatalf("upload: %v", err)
	}
	rec, ok := store.Latest("a")
	if !ok || rec.VersionID != "new" || !rec.IsLatest {
		t.Fatalf("latest a = %+v, %v", rec, ok)
	}
	history, _ := store.History("a")
	if len(history) != 2 || history[0].VersionID != "new" || history[0].IsLatest != true || history[1].IsLatest {
		t.Fatalf("history = %+v", history)
	}
}

func TestAbortKeepsUploadsAndDiscardsPages(t *testing.T) {
	store := NewStore()
	gen := store.Begin()
	_, err := gen.ApplyPage(Page{
		Versions:            []ObjectVersion{{Key: "staged", VersionID: "v1", IsLatest: true, LastModified: at(1)}},
		IsTruncated:         true,
		NextKeyMarker:       "staged",
		NextVersionIDMarker: "v1",
	})
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if err := store.RecordUpload(ObjectVersion{Key: "live", VersionID: "v1", LastModified: at(2)}); err != nil {
		t.Fatalf("upload: %v", err)
	}
	gen.Abort()

	snapshot := store.Snapshot()
	if snapshot.HasKey("staged") {
		t.Fatal("aborted page leaked into snapshot")
	}
	if rec, ok := snapshot.Latest("live"); !ok || rec.VersionID != "v1" {
		t.Fatalf("upload lost on abort: %+v, %v", rec, ok)
	}
	if _, err := gen.ApplyPage(Page{}); !errors.Is(err, ErrGenerationClosed) {
		t.Fatalf("apply after abort = %v, want ErrGenerationClosed", err)
	}
}

func TestConflictingEntryKindsRejectedAtomically(t *testing.T) {
	store := NewStore()
	gen := store.Begin()
	_, err := gen.ApplyPage(Page{
		Versions:      []ObjectVersion{{Key: "a", VersionID: "v1", LastModified: at(1)}},
		DeleteMarkers: []DeleteMarker{{Key: "a", VersionID: "v1", LastModified: at(2)}},
		IsTruncated:   false,
	})
	if !errors.Is(err, ErrRecordConflict) {
		t.Fatalf("conflict error = %v, want ErrRecordConflict", err)
	}
	if got := gen.Progress().Records; got != 0 {
		t.Fatalf("conflicting page partially applied: %d records", got)
	}

	_, err = gen.ApplyPage(Page{
		Versions:            []ObjectVersion{{Key: "a", VersionID: "v1", LastModified: at(1)}},
		IsTruncated:         true,
		NextKeyMarker:       "a",
		NextVersionIDMarker: "v1",
	})
	if err != nil {
		t.Fatalf("valid page after conflict: %v", err)
	}
	_, err = gen.ApplyPage(Page{
		DeleteMarkers: []DeleteMarker{{Key: "a", VersionID: "v1", LastModified: at(2)}},
	})
	// The second page completes the traversal and conflicts with staged data;
	// the page is rejected before completion.
	if !errors.Is(err, ErrRecordConflict) {
		t.Fatalf("cross-page conflict = %v, want ErrRecordConflict", err)
	}
	if gen.Progress().Complete {
		t.Fatal("rejected page completed the traversal")
	}
}

func TestAliasFieldsAndNullVersionID(t *testing.T) {
	store := NewStore()
	_, err := store.ApplyPage(Page{
		Versions: []ObjectVersion{
			{Key: "a", VersionId: "alias", IsLatest: true, LastModified: at(1)},
			{Key: "b", LastModified: at(1)},
		},
		IsTruncated:         true,
		NextKeyMarker:       "b",
		NextVersionIdMarker: "null",
	})
	if err != nil {
		t.Fatalf("apply aliases: %v", err)
	}
	genProgress, _ := store.Progress()
	if genProgress.Marker.KeyMarker != "b" || genProgress.Marker.VersionIDMarker != "null" {
		t.Fatalf("alias marker = %+v", genProgress.Marker)
	}
	if err := store.Publish(); !errors.Is(err, ErrIncompleteTraversal) {
		t.Fatalf("publish truncated = %v", err)
	}
	if _, err := store.ApplyPage(Page{IsTruncated: false}); err != nil {
		t.Fatalf("final empty page: %v", err)
	}
	if err := store.Publish(); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if rec, ok := store.Latest("a"); !ok || rec.VersionID != "alias" {
		t.Fatalf("alias version = %+v, %v", rec, ok)
	}
	if rec, ok := store.Latest("b"); !ok || rec.VersionID != "null" {
		t.Fatalf("null version = %+v, %v", rec, ok)
	}
}

func TestCollectFetchErrorLeavesPublishedStateUntouched(t *testing.T) {
	store := NewStore()
	base := store.Snapshot()
	_, err := store.Collect(context.Background(), func(context.Context, Marker) (Page, error) {
		return Page{}, errors.New("network down")
	})
	if err == nil {
		t.Fatal("expected fetch error")
	}
	if store.Snapshot() != base {
		t.Fatal("failed traversal changed the published snapshot")
	}
	if _, ok := store.Progress(); ok {
		t.Fatal("failed traversal left an active generation")
	}
}

func TestConcurrentSnapshotsAndUploads(t *testing.T) {
	store := NewStore()
	gen := store.Begin()

	const writers = 12
	var wg sync.WaitGroup
	wg.Add(writers * 2)
	for i := 0; i < writers; i++ {
		i := i
		go func() {
			defer wg.Done()
			if err := store.RecordUpload(ObjectVersion{
				Key:          fmt.Sprintf("k%02d", i),
				VersionID:    fmt.Sprintf("v%02d", i),
				IsLatest:     true,
				LastModified: at(int64(10 + i)),
			}); err != nil {
				t.Errorf("upload %d: %v", i, err)
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				s := store.Snapshot()
				_ = s.LatestView()
				_ = s.HistoryView()
				_, _ = s.Latest("k00")
			}
		}()
	}
	wg.Wait()

	if _, err := gen.ApplyPage(Page{
		Versions: []ObjectVersion{{Key: "inventory", VersionID: "v1", IsLatest: true, LastModified: at(1)}},
	}); err != nil {
		t.Fatalf("apply final: %v", err)
	}
	if err := gen.Publish(); err != nil {
		t.Fatalf("publish: %v", err)
	}
	if got, want := store.Snapshot().LatestLen(), writers+1; got != want {
		t.Fatalf("latest length = %d, want %d", got, want)
	}
}
