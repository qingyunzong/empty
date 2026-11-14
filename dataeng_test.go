package dataeng

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestPublishReadAndVerify(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	writer := NewWriter(store, "warehouse/events")

	version, err := writer.WriteBatch(ctx, []Input{
		{Path: "a.txt", Data: []byte("alpha")},
		{Path: "nested/b.txt", Data: []byte("bravo")},
	})
	if err != nil {
		t.Fatalf("WriteBatch: %v", err)
	}
	if version.Generation != 1 || version.Parent != "" {
		t.Fatalf("first version = generation %d parent %q", version.Generation, version.Parent)
	}

	reader := NewReader(store, "warehouse/events")
	snapshot, err := reader.Open(ctx)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if snapshot.Generation != 1 || snapshot.ParentID != "" {
		t.Fatalf("snapshot = generation %d parent %q", snapshot.Generation, snapshot.ParentID)
	}
	if len(snapshot.Files) != 2 || len(snapshot.Batch) != 2 {
		t.Fatalf("files=%d batch=%d", len(snapshot.Files), len(snapshot.Batch))
	}
	if got, err := reader.Read(ctx, "a.txt"); err != nil || string(got) != "alpha" {
		t.Fatalf("Read a.txt = %q, %v", got, err)
	}
	if got, err := reader.Read(ctx, "nested/b.txt"); err != nil || string(got) != "bravo" {
		t.Fatalf("Read nested/b.txt = %q, %v", got, err)
	}
	if err := reader.Verify(ctx); err != nil {
		t.Fatalf("Verify: %v", err)
	}

	pointer, err := reader.Head(ctx)
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	if pointer.Manifest != version.Manifest || pointer.Generation != version.Generation {
		t.Fatalf("pointer = %+v, version = %+v", pointer, version)
	}
}

func TestNoHeadAndEmptyBatch(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	reader := NewReader(store, "empty")
	if _, err := reader.Open(ctx); !errors.Is(err, ErrNoHead) {
		t.Fatalf("Open error = %v, want ErrNoHead", err)
	}
	writer := NewWriter(store, "empty")
	if _, err := writer.Commit(ctx); !errors.Is(err, ErrEmptyBatch) {
		t.Fatalf("Commit error = %v, want ErrEmptyBatch", err)
	}
	if _, err := writer.WriteBatch(ctx, nil); !errors.Is(err, ErrEmptyBatch) {
		t.Fatalf("WriteBatch error = %v, want ErrEmptyBatch", err)
	}
}

func TestVersionChainAndVisibleOverrides(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	writer := NewWriter(store, "chain")

	first, err := writer.WriteBatch(ctx, []Input{
		{Path: "keep.txt", Data: []byte("v1")},
		{Path: "replace.txt", Data: []byte("old")},
		{Path: "gone.txt", Data: []byte("gone")},
	})
	if err != nil {
		t.Fatalf("first batch: %v", err)
	}
	second, err := writer.WriteBatch(ctx, []Input{
		{Path: "replace.txt", Data: []byte("new")},
		{Path: "added.txt", Data: []byte("added")},
	})
	if err != nil {
		t.Fatalf("second batch: %v", err)
	}
	if second.Generation != 2 || second.Parent != first.Manifest {
		t.Fatalf("second version = %+v", second)
	}

	reader := NewReader(store, "chain")
	snapshot, err := reader.Open(ctx)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if snapshot.Generation != 2 || snapshot.ParentID != first.Manifest {
		t.Fatalf("snapshot generation/parent = %d/%s", snapshot.Generation, snapshot.ParentID)
	}
	if len(snapshot.History) != 2 || snapshot.History[0] != first.Manifest || snapshot.History[1] != second.Manifest {
		t.Fatalf("history = %v", snapshot.History)
	}

	values := make(map[string]string)
	for _, file := range snapshot.Files {
		data, err := reader.ReadFile(ctx, file)
		if err != nil {
			t.Fatalf("ReadFile %s: %v", file.Path, err)
		}
		values[file.Path] = string(data)
	}
	if values["keep.txt"] != "v1" || values["replace.txt"] != "new" ||
		values["added.txt"] != "added" || values["gone.txt"] != "gone" {
		t.Fatalf("visible values = %#v", values)
	}
}

func TestOpenAtKeepsOldSnapshotStable(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	writer := NewWriter(store, "snapshots")
	reader := NewReader(store, "snapshots")

	first, err := writer.WriteBatch(ctx, []Input{{Path: "a", Data: []byte("one")}})
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	firstSnapshot, err := reader.Open(ctx)
	if err != nil {
		t.Fatalf("Open first: %v", err)
	}

	second, err := writer.WriteBatch(ctx, []Input{{Path: "b", Data: []byte("two")}})
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if second.Generation != 2 {
		t.Fatalf("second generation = %d", second.Generation)
	}

	pinned, err := reader.OpenAt(ctx, first.Manifest)
	if err != nil {
		t.Fatalf("OpenAt: %v", err)
	}
	if pinned.Generation != firstSnapshot.Generation || len(pinned.Files) != 1 || pinned.Files[0].Path != "a" {
		t.Fatalf("pinned snapshot changed: %+v", pinned)
	}
	if data, err := reader.ReadFile(ctx, pinned.Files[0]); err != nil || string(data) != "one" {
		t.Fatalf("pinned data = %q, %v", data, err)
	}

	current, err := reader.Open(ctx)
	if err != nil {
		t.Fatalf("Open current: %v", err)
	}
	if current.Generation != 2 || len(current.Files) != 2 {
		t.Fatalf("current snapshot = %+v", current)
	}
}

func TestConcurrentPublishersAllVisibleAndLinear(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	const writers = 12

	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			writer := NewWriter(store, "concurrent",
				WithWriterID(fmt.Sprintf("writer-%d", i)),
				WithMaxAttempts(128),
				WithDataVerification(false),
				WithClock(func() time.Time {
					return time.Unix(int64(1700000000+i), 0).UTC()
				}),
			)
			_, err := writer.WriteBatch(ctx, []Input{{
				Path: fmt.Sprintf("file-%02d", i),
				Data: []byte(fmt.Sprintf("payload-%02d", i)),
			}})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent publish: %v", err)
		}
	}

	reader := NewReader(store, "concurrent")
	snapshot, err := reader.Open(ctx)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if snapshot.Generation != writers {
		t.Fatalf("generation = %d, want %d", snapshot.Generation, writers)
	}
	if len(snapshot.History) != writers || len(snapshot.Files) != writers {
		t.Fatalf("history=%d files=%d", len(snapshot.History), len(snapshot.Files))
	}
	if err := reader.Verify(ctx); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestConcurrentPublishersPlainPutGetList(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	memory := NewMemoryStore()
	// StoreFunc deliberately exposes only Put/Get/List and hides the
	// ConditionalStore implementation.
	plain := StoreFunc{
		PutFunc:  memory.Put,
		GetFunc:  memory.Get,
		ListFunc: memory.List,
	}
	const writers = 8

	var wg sync.WaitGroup
	errs := make(chan error, writers)
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			writer := NewWriter(plain, "plain",
				WithMaxAttempts(128), WithDataVerification(false))
			_, err := writer.WriteBatch(ctx, []Input{{
				Path: fmt.Sprintf("p-%02d", i),
				Data: []byte(fmt.Sprintf("d-%02d", i)),
			}})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("plain-store publish: %v", err)
		}
	}

	reader := NewReader(plain, "plain")
	snapshot, err := reader.Open(ctx)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if snapshot.Generation != writers || len(snapshot.Files) != writers {
		t.Fatalf("generation=%d files=%d, want %d", snapshot.Generation, len(snapshot.Files), writers)
	}
	if err := reader.Verify(ctx); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

type headBarrierStore struct {
	*MemoryStore
	headKey string
	mu      sync.Mutex
	arrived int
	want    int
	release chan struct{}
	opened  bool
}

func newHeadBarrierStore(headKey string, want int) *headBarrierStore {
	return &headBarrierStore{
		MemoryStore: NewMemoryStore(),
		headKey:     headKey,
		want:        want,
		release:     make(chan struct{}),
	}
}

func (s *headBarrierStore) PutIfMatch(ctx context.Context, key string, data []byte, expected string) error {
	if key == s.headKey {
		s.mu.Lock()
		if !s.opened {
			s.arrived++
			if s.arrived == s.want {
				s.opened = true
				close(s.release)
			}
			release := s.release
			s.mu.Unlock()
			<-release
		} else {
			s.mu.Unlock()
		}
	}
	return s.MemoryStore.PutIfMatch(ctx, key, data, expected)
}

func TestConflictLoserDoesNotOverwriteWinner(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	const prefix = "race"
	store := newHeadBarrierStore(headKey(prefix), 2)

	winnerWriter := NewWriter(store, prefix,
		WithMaxAttempts(1), WithDataVerification(false))
	loserWriter := NewWriter(store, prefix,
		WithMaxAttempts(1), WithDataVerification(false))

	if _, err := winnerWriter.Add(ctx, "winner.txt", []byte("winner")); err != nil {
		t.Fatalf("stage winner: %v", err)
	}
	if _, err := loserWriter.Add(ctx, "loser.txt", []byte("loser")); err != nil {
		t.Fatalf("stage loser: %v", err)
	}

	type result struct {
		writer *Writer
		name   string
		ver    Version
		err    error
	}
	results := make(chan result, 2)
	for _, item := range []struct {
		writer *Writer
		name   string
	}{
		{winnerWriter, "winner"},
		{loserWriter, "loser"},
	} {
		go func(writer *Writer, name string) {
			version, err := writer.Commit(ctx)
			results <- result{writer: writer, name: name, ver: version, err: err}
		}(item.writer, item.name)
	}

	var won, lost result
	for i := 0; i < 2; i++ {
		got := <-results
		if got.err == nil {
			won = got
		} else if errors.Is(got.err, ErrConflict) {
			lost = got
		} else {
			t.Fatalf("%s: unexpected error %v", got.name, got.err)
		}
	}
	if won.writer == nil || lost.writer == nil {
		t.Fatalf("expected one winner and one conflict: won=%+v lost=%+v", won, lost)
	}
	if won.ver.Generation != 1 || lost.ver.Generation != 0 {
		t.Fatalf("winner=%+v loser=%+v", won.ver, lost.ver)
	}

	reader := NewReader(store, prefix)
	before, err := reader.Open(ctx)
	if err != nil {
		t.Fatalf("Open after race: %v", err)
	}
	if before.Generation != 1 || len(before.Files) != 1 {
		t.Fatalf("head after race = %+v", before)
	}
	winnerPath := before.Files[0].Path
	if winnerPath != "winner.txt" && winnerPath != "loser.txt" {
		t.Fatalf("unexpected winner path %q", winnerPath)
	}
	winnerManifest := before.ManifestID

	// The loser still has its staged file. Committing again must rebase on
	// the winner and advance to generation 2 without changing generation 1.
	rebased, err := lost.writer.Commit(ctx)
	if err != nil {
		t.Fatalf("loser rebase: %v", err)
	}
	if rebased.Generation != 2 || rebased.Parent != winnerManifest {
		t.Fatalf("rebased version = %+v, winner manifest = %s", rebased, winnerManifest)
	}

	after, err := reader.Open(ctx)
	if err != nil {
		t.Fatalf("Open after rebase: %v", err)
	}
	if after.Generation != 2 || len(after.Files) != 2 {
		t.Fatalf("head after rebase = %+v", after)
	}
	if after.History[0] != winnerManifest {
		t.Fatalf("winner manifest was replaced: history=%v winner=%s", after.History, winnerManifest)
	}
	if err := reader.Verify(ctx); err != nil {
		t.Fatalf("Verify: %v", err)
	}
}

func TestReaderRejectsCorruptDataDigest(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	writer := NewWriter(store, "corrupt-data")
	version, err := writer.WriteBatch(ctx, []Input{{Path: "a", Data: []byte("original")}})
	if err != nil {
		t.Fatalf("publish: %v", err)
	}

	file := version.Files[0]
	key, err := dataKey("corrupt-data", file.Digest)
	if err != nil {
		t.Fatalf("dataKey: %v", err)
	}
	if err := store.Put(ctx, key, []byte("tampered")); err != nil {
		t.Fatalf("tamper: %v", err)
	}

	reader := NewReader(store, "corrupt-data")
	if _, err := reader.Read(ctx, "a"); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("Read error = %v, want ErrDigestMismatch", err)
	}
	if err := reader.Verify(ctx); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("Verify error = %v, want ErrDigestMismatch", err)
	}
}

func TestReaderRejectsCorruptManifestDigest(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	writer := NewWriter(store, "corrupt-manifest")
	if _, err := writer.WriteBatch(ctx, []Input{{Path: "a", Data: []byte("x")}}); err != nil {
		t.Fatalf("publish: %v", err)
	}
	reader := NewReader(store, "corrupt-manifest")
	pointer, err := reader.Head(ctx)
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	key, err := manifestKey("corrupt-manifest", pointer.Manifest)
	if err != nil {
		t.Fatalf("manifestKey: %v", err)
	}
	raw, err := store.Get(ctx, key)
	if err != nil {
		t.Fatalf("Get manifest: %v", err)
	}
	// A trailing space keeps the JSON decodable but changes its digest.
	if err := store.Put(ctx, key, append(raw, ' ')); err != nil {
		t.Fatalf("tamper: %v", err)
	}
	if _, err := reader.Open(ctx); !errors.Is(err, ErrDigestMismatch) {
		t.Fatalf("Open error = %v, want ErrDigestMismatch", err)
	}
}

func TestReaderRejectsBadParentVersion(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	writer := NewWriter(store, "bad-parent")
	first, err := writer.WriteBatch(ctx, []Input{{Path: "a", Data: []byte("one")}})
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	if _, err := writer.WriteBatch(ctx, []Input{{Path: "b", Data: []byte("two")}}); err != nil {
		t.Fatalf("second: %v", err)
	}
	reader := NewReader(store, "bad-parent")
	pointer, err := reader.Head(ctx)
	if err != nil {
		t.Fatalf("Head: %v", err)
	}
	head, err := reader.Manifest(ctx, pointer.Manifest)
	if err != nil {
		t.Fatalf("Manifest: %v", err)
	}

	bad := *head
	bad.Parent = Digest([]byte("this manifest does not exist"))
	badID, err := NewPublisher(store, "bad-parent").PutManifest(ctx, &bad)
	if err != nil {
		t.Fatalf("PutManifest: %v", err)
	}
	badPointer := Pointer{
		Format:     PointerFormat,
		Generation: bad.Generation,
		Manifest:   badID,
		Previous:   bad.Parent,
		UpdatedAt:  bad.CreatedAt,
	}
	raw, err := badPointer.Bytes()
	if err != nil {
		t.Fatalf("pointer bytes: %v", err)
	}
	if err := store.Put(ctx, headKey("bad-parent"), raw); err != nil {
		t.Fatalf("replace head: %v", err)
	}

	if _, err := reader.Open(ctx); !errors.Is(err, ErrObjectNotFound) {
		t.Fatalf("Open error = %v, want missing parent", err)
	}

	// A generation that does not match the parent's generation is also
	// rejected before the parent is used.
	bad.Generation = 3
	bad.Parent = first.Manifest
	badID, err = NewPublisher(store, "bad-parent").PutManifest(ctx, &bad)
	if err != nil {
		t.Fatalf("PutManifest generation: %v", err)
	}
	badPointer.Generation = 3
	badPointer.Manifest = badID
	badPointer.Previous = bad.Parent
	raw, _ = badPointer.Bytes()
	if err := store.Put(ctx, headKey("bad-parent"), raw); err != nil {
		t.Fatalf("replace head: %v", err)
	}
	if _, err := reader.Open(ctx); !errors.Is(err, ErrParentMismatch) {
		t.Fatalf("Open error = %v, want ErrParentMismatch", err)
	}
}

func TestDuplicateAndInvalidPaths(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	writer := NewWriter(NewMemoryStore(), "paths")
	if _, err := writer.Add(ctx, "same", []byte("one")); err != nil {
		t.Fatalf("Add: %v", err)
	}
	if _, err := writer.Add(ctx, "same", []byte("two")); !errors.Is(err, ErrDuplicatePath) {
		t.Fatalf("duplicate Add error = %v", err)
	}
	if _, err := writer.WriteBatch(ctx, []Input{
		{Path: "x", Data: []byte("1")},
		{Path: "x", Data: []byte("2")},
	}); !errors.Is(err, ErrDuplicatePath) {
		t.Fatalf("duplicate WriteBatch error = %v", err)
	}
	if _, err := writer.Add(ctx, "/absolute", []byte("x")); err == nil {
		t.Fatal("absolute path accepted")
	}
}

func TestPublishFilesIntegration(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	writer := NewWriter(store, "integration")
	first, err := writer.Upload(ctx, "a", []byte("alpha"))
	if err != nil {
		t.Fatalf("Upload a: %v", err)
	}
	second, err := writer.Upload(ctx, "b", []byte("bravo"))
	if err != nil {
		t.Fatalf("Upload b: %v", err)
	}
	third, err := writer.Upload(ctx, "c", []byte("charlie"))
	if err != nil {
		t.Fatalf("Upload c: %v", err)
	}
	// A producer that only knows the digest may omit Object; PublishFiles
	// derives the canonical content-addressed key.
	derived := File{Path: "c", Digest: third.Digest, Size: third.Size}
	version, err := writer.PublishFiles(ctx, []File{second, first, derived})
	if err != nil {
		t.Fatalf("PublishFiles: %v", err)
	}
	if version.Generation != 1 || len(version.Files) != 3 {
		t.Fatalf("version = %+v", version)
	}
	reader := NewReader(store, "integration")
	snapshot, err := reader.Open(ctx)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if len(snapshot.Files) != 3 || snapshot.Files[0].Path != "a" ||
		snapshot.Files[1].Path != "b" || snapshot.Files[2].Path != "c" {
		t.Fatalf("files = %+v", snapshot.Files)
	}
	if string(mustRead(t, reader, "c")) != "charlie" {
		t.Fatalf("derived object was not readable")
	}
}

func mustRead(t *testing.T, reader *Reader, path string) []byte {
	t.Helper()
	data, err := reader.Read(context.Background(), path)
	if err != nil {
		t.Fatalf("Read %s: %v", path, err)
	}
	return data
}

func TestContentAddressingReusesAndPreservesBytes(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	writer := NewWriter(store, "cas")

	first, err := writer.WriteBatch(ctx, []Input{{Path: "same", Data: []byte("one")}})
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	second, err := writer.WriteBatch(ctx, []Input{{Path: "same", Data: []byte("two")}})
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if first.Files[0].Object == second.Files[0].Object {
		t.Fatal("different content used the same content address")
	}

	reader := NewReader(store, "cas")
	oldSnapshot, err := reader.OpenAt(ctx, first.Manifest)
	if err != nil {
		t.Fatalf("OpenAt: %v", err)
	}
	oldData, err := reader.ReadFile(ctx, oldSnapshot.Files[0])
	if err != nil {
		t.Fatalf("read old: %v", err)
	}
	if string(oldData) != "one" {
		t.Fatalf("old data = %q", oldData)
	}

	// Publishing identical content again is idempotent at the data-object
	// level and never assigns a new address.
	third, err := writer.WriteBatch(ctx, []Input{{Path: "other", Data: []byte("two")}})
	if err != nil {
		t.Fatalf("third: %v", err)
	}
	if third.Files[0].Object != second.Files[0].Object {
		t.Fatalf("identical content got different addresses: %s vs %s",
			third.Files[0].Object, second.Files[0].Object)
	}
}

func TestSortedManifestFiles(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	store := NewMemoryStore()
	writer := NewWriter(store, "sorted")
	version, err := writer.WriteBatch(ctx, []Input{
		{Path: "z", Data: []byte("z")},
		{Path: "a", Data: []byte("a")},
		{Path: "m", Data: []byte("m")},
	})
	if err != nil {
		t.Fatalf("WriteBatch: %v", err)
	}
	want := []string{"a", "m", "z"}
	for i, file := range version.Files {
		if file.Path != want[i] {
			t.Fatalf("files not canonical: %+v", version.Files)
		}
	}
}
