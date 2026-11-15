package dataeng_test

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"

	"example.org/dataeng/q0213"
)

func TestFileStoreRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "state.json")
	store := dataeng.NewFileStore(path)
	ctx := context.Background()

	st := dataeng.New()
	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}
	if _, err := st.Reconcile("INBOX", []dataeng.Message{msg(t, 1, 10, "body")}); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if err := st.ApplyExpunge("INBOX", 1, 11); err != nil {
		t.Fatalf("expunge: %v", err)
	}
	if _, err := st.Select("INBOX", 200); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	if err := st.Save(ctx, store); err != nil {
		t.Fatalf("save: %v", err)
	}

	restored := dataeng.New()
	loaded, err := restored.Load(ctx, store)
	if err != nil || !loaded {
		t.Fatalf("load: loaded=%v err=%v", loaded, err)
	}

	numbers, err := restored.Generations("INBOX")
	if err != nil || len(numbers) != 2 {
		t.Fatalf("generations after restore: %v err=%v", numbers, err)
	}
	oldView, err := restored.Generation("INBOX", 1)
	if err != nil {
		t.Fatalf("old generation: %v", err)
	}
	if len(oldView.Tombstones) != 1 || oldView.Tombstones[0].UID != 1 {
		t.Fatalf("tombstone evidence not restored: %+v", oldView.Tombstones)
	}
	sel, err := restored.Select("INBOX", 200)
	if err != nil || !sel.FullRescan || sel.Generation != 2 {
		t.Fatalf("restored active generation wrong: %+v err=%v", sel, err)
	}

	// Restored state is independent: mutating it must not touch the source.
	if err := restored.ApplyFetch("INBOX", msg(t, 7, 21, "seven")); err != nil {
		t.Fatalf("fetch after restore: %v", err)
	}
	if _, ok := st.Message("INBOX", 7); ok {
		t.Fatal("restored state shares storage with the source state")
	}
}

func TestMemoryStoreAndNoSnapshot(t *testing.T) {
	ctx := context.Background()
	store := dataeng.NewMemoryStore()

	st := dataeng.New()
	loaded, err := st.Load(ctx, store)
	if err != nil || loaded {
		t.Fatalf("empty store: loaded=%v err=%v", loaded, err)
	}
	if _, err := store.Load(ctx); !errors.Is(err, dataeng.ErrNoSnapshot) {
		t.Fatalf("expected ErrNoSnapshot, got %v", err)
	}

	if _, err := st.Select("Archive", 7); err != nil {
		t.Fatalf("select: %v", err)
	}
	if err := st.ApplyFetch("Archive", msg(t, 3, 5, "hi")); err != nil {
		t.Fatalf("fetch: %v", err)
	}
	if err := st.Save(ctx, store); err != nil {
		t.Fatalf("save: %v", err)
	}

	other := dataeng.New()
	loaded, err = other.Load(ctx, store)
	if err != nil || !loaded {
		t.Fatalf("load memory store: loaded=%v err=%v", loaded, err)
	}
	message, ok := other.Message("Archive", 3)
	if !ok || !message.Digest.Equal(mustDigest(t, "hi")) {
		t.Fatalf("message not restored: %+v ok=%v", message, ok)
	}
}

func TestSnapshotRejectsBadInput(t *testing.T) {
	st := dataeng.New()
	if err := st.Restore(dataeng.Snapshot{Version: 99}); !errors.Is(err, dataeng.ErrInvalidArgument) {
		t.Fatalf("expected version error, got %v", err)
	}
	if err := st.Restore(dataeng.Snapshot{
		Version:   1,
		Mailboxes: map[string]*dataeng.Mailbox{"": nil},
	}); !errors.Is(err, dataeng.ErrInvalidArgument) {
		t.Fatalf("expected mailbox error, got %v", err)
	}
}

func TestConcurrentAccess(t *testing.T) {
	st := dataeng.New()
	if _, err := st.Select("INBOX", 100); err != nil {
		t.Fatalf("select: %v", err)
	}

	var wg sync.WaitGroup
	for worker := 0; worker < 8; worker++ {
		wg.Add(1)
		go func(base uint32) {
			defer wg.Done()
			for i := uint32(0); i < 25; i++ {
				uid := base*100 + i + 1
				_ = st.ApplyFetch("INBOX", msg(t, uid, uint64(uid), "body"))
				_, _ = st.Message("INBOX", uid)
				_, _ = st.Tombstone("INBOX", uid)
				_ = st.ApplyExpunge("INBOX", uid, uint64(uid)+1)
			}
		}(uint32(worker))
	}
	wg.Wait()

	view, err := st.Generation("INBOX", 1)
	if err != nil {
		t.Fatalf("generation view: %v", err)
	}
	if len(view.Messages) != 0 || len(view.Tombstones) != 8*25 {
		t.Fatalf("concurrent state wrong: messages=%d tombstones=%d",
			len(view.Messages), len(view.Tombstones))
	}
}
