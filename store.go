package dataeng

import (
	"context"
	"fmt"
	"sync"
)

// Store owns the published snapshot and at most one staging generation.
// All methods are safe for concurrent use.
type Store struct {
	mu sync.RWMutex

	published  *Snapshot
	generation *Generation
	uploads    *recordSet

	nextSeq        uint64
	nextGeneration uint64
	nextSnapshot   uint64
}

// NewStore creates an empty inventory store.
func NewStore() *Store {
	s := &Store{uploads: newRecordSet()}
	s.published = newSnapshot(0, Marker{}, newRecordSet())
	return s
}

// New is an alias for NewStore.
func New() *Store {
	return NewStore()
}

// NewInventory is an alias for NewStore.
func NewInventory() *Store {
	return NewStore()
}

// NewInventoryStore is an alias for NewStore.
func NewInventoryStore() *Store {
	return NewStore()
}

// Begin starts a new staging generation. If a generation is already open it is
// closed and its uncommitted pages are discarded; use TryBegin when a caller
// needs to detect that situation.
func (s *Store) Begin() *Generation {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != nil {
		s.generation.closed = true
	}
	return s.newGenerationLocked()
}

// NewGeneration is an alias for Begin.
func (s *Store) NewGeneration() *Generation {
	return s.Begin()
}

// TryBegin starts a generation only when no other generation is open.
func (s *Store) TryBegin() (*Generation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != nil {
		return nil, ErrGenerationActive
	}
	return s.newGenerationLocked(), nil
}

func (s *Store) newGenerationLocked() *Generation {
	s.nextGeneration++
	g := &Generation{
		store:  s,
		number: s.nextGeneration,
		set:    newRecordSet(),
	}
	s.generation = g
	return g
}

// ApplyPage applies a page to the active generation. If no generation is open,
// one is created automatically so a simple caller does not need to manage the
// generation lifetime explicitly.
func (s *Store) ApplyPage(page Page) (ApplyResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation == nil {
		s.newGenerationLocked()
	}
	return s.applyPageLocked(s.generation, page)
}

// Apply is an alias for ApplyPage.
func (s *Store) Apply(page Page) (ApplyResult, error) {
	return s.ApplyPage(page)
}

// Publish atomically exposes the active generation's complete traversal.
func (s *Store) Publish() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation == nil {
		return ErrNoActiveGeneration
	}
	return s.publishLocked(s.generation)
}

// Commit is an alias for Publish.
func (s *Store) Commit() error {
	return s.Publish()
}

// Abort discards the active generation's staged pages. Recorded concurrent
// uploads are retained and merged into the current published snapshot.
func (s *Store) Abort() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != nil {
		s.abortLocked(s.generation)
	}
}

// RecordUpload records a version written outside the inventory traversal. If
// no generation is active it becomes visible immediately; during a traversal
// it is merged into the snapshot at publication. A zero LastModified is
// stamped with the observation time so a concurrent upload is ordered as a
// current event.
func (s *Store) RecordUpload(version ObjectVersion) error {
	rec, err := version.record()
	if err != nil {
		return err
	}
	rec.LastModified = stampUploadTime(rec.LastModified)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != nil {
		if cur, ok := s.generation.set.get(rec.Key, rec.VersionID); ok && cur.rec.DeleteMarker != rec.DeleteMarker {
			return fmt.Errorf("record upload %q/%q: %w", rec.Key, rec.VersionID, ErrRecordConflict)
		}
	} else if cur, ok := s.published.set.get(rec.Key, rec.VersionID); ok && cur.rec.DeleteMarker != rec.DeleteMarker {
		return fmt.Errorf("record upload %q/%q: %w", rec.Key, rec.VersionID, ErrRecordConflict)
	}
	if _, _, _, err := s.uploads.put(rec, true, s.seq); err != nil {
		return fmt.Errorf("record upload %q/%q: %w", rec.Key, rec.VersionID, err)
	}
	if s.generation != nil {
		return nil
	}
	return s.rebuildPublishedLocked()
}

// PutVersion is an alias for RecordUpload.
func (s *Store) PutVersion(version ObjectVersion) error {
	return s.RecordUpload(version)
}

// RecordVersion is an alias for RecordUpload.
func (s *Store) RecordVersion(version ObjectVersion) error {
	return s.RecordUpload(version)
}

// RecordDeleteMarker records a delete marker written outside the traversal.
// Its visibility rules are the same as RecordUpload.
func (s *Store) RecordDeleteMarker(marker DeleteMarker) error {
	rec, err := marker.record()
	if err != nil {
		return err
	}
	rec.LastModified = stampUploadTime(rec.LastModified)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != nil {
		if cur, ok := s.generation.set.get(rec.Key, rec.VersionID); ok && cur.rec.DeleteMarker != rec.DeleteMarker {
			return fmt.Errorf("record delete marker %q/%q: %w", rec.Key, rec.VersionID, ErrRecordConflict)
		}
	} else if cur, ok := s.published.set.get(rec.Key, rec.VersionID); ok && cur.rec.DeleteMarker != rec.DeleteMarker {
		return fmt.Errorf("record delete marker %q/%q: %w", rec.Key, rec.VersionID, ErrRecordConflict)
	}
	if _, _, _, err := s.uploads.put(rec, true, s.seq); err != nil {
		return fmt.Errorf("record delete marker %q/%q: %w", rec.Key, rec.VersionID, err)
	}
	if s.generation != nil {
		return nil
	}
	return s.rebuildPublishedLocked()
}

// PutDeleteMarker is an alias for RecordDeleteMarker.
func (s *Store) PutDeleteMarker(marker DeleteMarker) error {
	return s.RecordDeleteMarker(marker)
}

// Snapshot returns the currently published immutable snapshot.
func (s *Store) Snapshot() *Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.published
}

// Latest returns the live version for key from the published snapshot.
func (s *Store) Latest(key string) (Record, bool) {
	return s.Snapshot().Latest(key)
}

// GetLatest is an alias for Latest.
func (s *Store) GetLatest(key string) (Record, bool) {
	return s.Latest(key)
}

// History returns all versions for key from the published snapshot.
func (s *Store) History(key string) ([]Record, bool) {
	return s.Snapshot().History(key)
}

// Versions returns all versions for key from the published snapshot.
func (s *Store) Versions(key string) []Record {
	return s.Snapshot().Versions(key)
}

// GetHistory is an alias for History.
func (s *Store) GetHistory(key string) ([]Record, bool) {
	return s.History(key)
}

// LatestView returns the published latest view.
func (s *Store) LatestView() []Record {
	return s.Snapshot().LatestView()
}

// LatestVersions is an alias for LatestView.
func (s *Store) LatestVersions() []Record {
	return s.LatestView()
}

// LatestEntry returns the newest entry for key, including a delete marker.
func (s *Store) LatestEntry(key string) (Record, bool) {
	return s.Snapshot().LatestEntry(key)
}

// LatestMap returns the published latest view keyed by object key.
func (s *Store) LatestMap() map[string]Record {
	return s.Snapshot().LatestMap()
}

// Deleted reports whether the newest entry for key is a delete marker.
func (s *Store) Deleted(key string) bool {
	return s.Snapshot().Deleted(key)
}

// Keys returns all observed keys in the published snapshot.
func (s *Store) Keys() []string {
	return s.Snapshot().Keys()
}

// HistoryView returns the published history view.
func (s *Store) HistoryView() []Record {
	return s.Snapshot().HistoryView()
}

// AllVersions is an alias for HistoryView.
func (s *Store) AllVersions() []Record {
	return s.HistoryView()
}

// Len returns the number of published version and delete-marker entries.
func (s *Store) Len() int {
	return s.Snapshot().Len()
}

// LatestLen returns the number of live objects in the published latest view.
func (s *Store) LatestLen() int {
	return s.Snapshot().LatestLen()
}

// Progress reports the active generation's traversal state.
func (s *Store) Progress() (Progress, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.generation == nil {
		return Progress{}, false
	}
	return s.generation.progressLocked(), true
}

func (s *Store) seq() uint64 {
	s.nextSeq++
	return s.nextSeq
}

func (s *Store) applyPageLocked(g *Generation, page Page) (ApplyResult, error) {
	result := ApplyResult{
		Truncated: page.IsTruncated,
		Marker:    g.marker,
	}
	if g.closed || s.generation != g {
		return result, ErrGenerationClosed
	}
	if g.complete {
		return s.retryFinalPageLocked(g, page, result)
	}

	records, err := page.records()
	if err != nil {
		return result, err
	}
	result.Records = len(records)

	next, err := page.NextMarker()
	if err != nil {
		return result, fmt.Errorf("%w: %v", ErrInvalidPage, err)
	}

	// Check all conflicts before mutating the generation so a rejected page
	// leaves the staging state unchanged.
	for _, rec := range records {
		if cur, ok := g.set.get(rec.Key, rec.VersionID); ok && cur.rec.DeleteMarker != rec.DeleteMarker {
			return result, fmt.Errorf("%w: %q/%q", ErrRecordConflict, rec.Key, rec.VersionID)
		}
		if pending, ok := s.uploads.get(rec.Key, rec.VersionID); ok && pending.rec.DeleteMarker != rec.DeleteMarker {
			return result, fmt.Errorf("%w: %q/%q", ErrRecordConflict, rec.Key, rec.VersionID)
		}
	}
	seen := make(map[recordIdentity]bool, len(records))
	for _, rec := range records {
		id := recordIdentity{key: rec.Key, versionID: rec.VersionID}
		if kind, ok := seen[id]; ok && kind != rec.DeleteMarker {
			return result, fmt.Errorf("%w: %q/%q", ErrRecordConflict, rec.Key, rec.VersionID)
		}
		seen[id] = rec.DeleteMarker
	}

	for _, rec := range records {
		added, updated, duplicate, err := g.set.put(rec, false, s.seq)
		if err != nil {
			return result, fmt.Errorf("%w: %q/%q", ErrRecordConflict, rec.Key, rec.VersionID)
		}
		switch {
		case added:
			result.Added++
		case updated:
			result.Updated++
		case duplicate:
			result.Duplicates++
		}
	}

	g.pages++
	previousMarker := g.marker
	if page.IsTruncated {
		if next.IsZero() || compareMarkers(next, g.marker) <= 0 {
			result.Marker = g.marker
			result.Stalled = true
			return result, fmt.Errorf("%w: current %s, next %s", ErrMarkerNotAdvanced, g.marker, next)
		}
		g.marker = next
		result.Marker = next
		result.MarkerAdvanced = true
		return result, nil
	}

	g.complete = true
	result.MarkerAdvanced = !next.IsZero() && compareMarkers(next, previousMarker) > 0
	if !next.IsZero() {
		g.marker = next
	}
	result.Marker = g.marker
	result.Complete = true
	return result, nil
}

// retryFinalPageLocked keeps an ambiguous retry of the final page idempotent.
// A page may be retried when its response was lost; as long as it introduces no
// new identity, merging it again leaves the completed generation unchanged.
// A different final page, or a truncated page arriving after completion, means
// the caller is trying to extend an already sealed traversal.
func (s *Store) retryFinalPageLocked(g *Generation, page Page, result ApplyResult) (ApplyResult, error) {
	if page.IsTruncated {
		return result, ErrTraversalComplete
	}
	records, err := page.records()
	if err != nil {
		return result, err
	}
	for _, rec := range records {
		if _, ok := g.set.get(rec.Key, rec.VersionID); !ok {
			return result, ErrTraversalComplete
		}
	}
	result.Records = len(records)
	result.Complete = true
	result.Marker = g.marker
	for _, rec := range records {
		added, updated, duplicate, err := g.set.put(rec, false, s.seq)
		if err != nil {
			return result, fmt.Errorf("%w: %q/%q", ErrRecordConflict, rec.Key, rec.VersionID)
		}
		if added {
			return result, ErrTraversalComplete
		}
		if updated {
			result.Updated++
		}
		if duplicate {
			result.Duplicates++
		}
	}
	return result, nil
}

func (s *Store) publishLocked(g *Generation) error {
	if g.closed || s.generation != g {
		return ErrGenerationClosed
	}
	if !g.complete {
		return ErrIncompleteTraversal
	}

	set := g.set.clone()
	if err := set.merge(s.uploads); err != nil {
		return fmt.Errorf("publish generation %d: %w", g.number, err)
	}

	s.nextSnapshot++
	published := newSnapshot(s.nextSnapshot, g.marker, set)
	s.published = published
	s.uploads = newRecordSet()
	g.closed = true
	s.generation = nil
	return nil
}

func (s *Store) abortLocked(g *Generation) {
	g.closed = true
	s.generation = nil
	if s.uploads.size > 0 {
		_ = s.rebuildPublishedLocked()
	}
}

func (s *Store) rebuildPublishedLocked() error {
	set := s.published.set.clone()
	if err := set.merge(s.uploads); err != nil {
		return fmt.Errorf("merge concurrent uploads: %w", err)
	}
	s.nextSnapshot++
	s.published = newSnapshot(s.nextSnapshot, s.published.marker, set)
	s.uploads = newRecordSet()
	return nil
}

// Generation is a staging traversal. Its pages are invisible until Publish.
type Generation struct {
	store  *Store
	number uint64
	set    *recordSet

	marker   Marker
	pages    int
	complete bool
	closed   bool
}

// Number returns the generation's monotonically increasing identifier.
func (g *Generation) Number() uint64 {
	return g.number
}

// ApplyPage merges a page into this generation.
func (g *Generation) ApplyPage(page Page) (ApplyResult, error) {
	s := g.store
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.applyPageLocked(g, page)
}

// Apply is an alias for ApplyPage.
func (g *Generation) Apply(page Page) (ApplyResult, error) {
	return g.ApplyPage(page)
}

// Publish atomically exposes this generation as the store's new snapshot.
func (g *Generation) Publish() error {
	s := g.store
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.publishLocked(g)
}

// Commit is an alias for Publish.
func (g *Generation) Commit() error {
	return g.Publish()
}

// Abort discards this generation. It is safe to call after Publish.
func (g *Generation) Abort() {
	s := g.store
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation == g {
		s.abortLocked(g)
		return
	}
	g.closed = true
}

// Complete reports whether this generation has seen its final page.
func (g *Generation) Complete() bool {
	s := g.store
	s.mu.RLock()
	defer s.mu.RUnlock()
	return g.complete
}

// Progress reports this generation's current traversal state.
func (g *Generation) Progress() Progress {
	s := g.store
	s.mu.RLock()
	defer s.mu.RUnlock()
	return g.progressLocked()
}

func (g *Generation) progressLocked() Progress {
	return Progress{
		Generation: g.number,
		Pages:      g.pages,
		Records:    g.set.size,
		Marker:     g.marker,
		Complete:   g.complete,
	}
}

type recordIdentity struct {
	key       string
	versionID string
}

// PageFetcher returns one ListObjectVersions page for the supplied cursor.
// Collect passes Marker{} on the first call and the previous page's next
// marker on subsequent calls.
type PageFetcher func(ctx context.Context, after Marker) (Page, error)

// Collect drives a complete ListObjectVersions traversal and publishes it.
// It stops with ErrMarkerNotAdvanced when a truncated page does not move the
// cursor, and never publishes a partial traversal.
func (s *Store) Collect(ctx context.Context, fetch PageFetcher) (*Snapshot, error) {
	if fetch == nil {
		return nil, fmt.Errorf("%w: nil page fetcher", ErrInvalidPage)
	}
	if ctx == nil {
		ctx = context.Background()
	}

	gen, err := s.TryBegin()
	if err != nil {
		return nil, err
	}

	marker := Marker{}
	for {
		if err := ctx.Err(); err != nil {
			gen.Abort()
			return nil, err
		}
		page, err := fetch(ctx, marker)
		if err != nil {
			gen.Abort()
			return nil, fmt.Errorf("fetch page after %s: %w", marker, err)
		}
		result, err := gen.ApplyPage(page)
		if err != nil {
			gen.Abort()
			return nil, err
		}
		if result.Complete {
			if err := gen.Publish(); err != nil {
				gen.Abort()
				return nil, err
			}
			return s.Snapshot(), nil
		}
		marker = result.Marker
	}
}
