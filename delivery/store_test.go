package delivery

import (
	"context"
	"errors"
	"testing"
)

func TestMemoryStoreCRUD(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	rec := Record{Tag: "t1", LinkEpoch: 1, DeliveryID: 7}

	if _, err := store.Get(ctx, rec.Tag); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v, want ErrNotFound", err)
	}
	if err := store.Put(ctx, rec); err != nil {
		t.Fatalf("Put: %v", err)
	}
	if err := store.Put(ctx, rec); !errors.Is(err, ErrAlreadyExists) {
		t.Fatalf("duplicate Put = %v, want ErrAlreadyExists", err)
	}
	got, err := store.Get(ctx, rec.Tag)
	if err != nil || got.DeliveryID != 7 {
		t.Fatalf("Get = %+v, %v", got, err)
	}

	got.DeliveryID = 9
	if err := store.Update(ctx, got); err != nil {
		t.Fatalf("Update: %v", err)
	}
	if got, _ := store.Get(ctx, rec.Tag); got.DeliveryID != 9 {
		t.Fatalf("DeliveryID = %d, want 9", got.DeliveryID)
	}
	if err := store.Update(ctx, Record{Tag: "missing"}); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Update missing = %v, want ErrNotFound", err)
	}

	store.Put(ctx, Record{Tag: "t2", Settled: true})
	unsettled, err := store.ListUnsettled(ctx)
	if err != nil {
		t.Fatalf("ListUnsettled: %v", err)
	}
	if len(unsettled) != 1 || unsettled[0].Tag != "t1" {
		t.Fatalf("ListUnsettled = %+v, want only t1", unsettled)
	}

	if err := store.Delete(ctx, "t1"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := store.Delete(ctx, "t1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Delete missing = %v, want ErrNotFound", err)
	}
}

func TestMemoryStoreEpoch(t *testing.T) {
	ctx := context.Background()
	store := NewMemoryStore()
	epoch, err := store.LoadEpoch(ctx)
	if err != nil || epoch != 0 {
		t.Fatalf("LoadEpoch = %d, %v", epoch, err)
	}
	if err := store.SaveEpoch(ctx, 3); err != nil {
		t.Fatalf("SaveEpoch: %v", err)
	}
	if epoch, _ := store.LoadEpoch(ctx); epoch != 3 {
		t.Fatalf("LoadEpoch = %d, want 3", epoch)
	}
}
