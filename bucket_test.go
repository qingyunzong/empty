package formal_test

import (
	"errors"
	"testing"
	"time"

	"example.org/dlks/formal/q10187"
)

func TestBucketValidation(t *testing.T) {
	start := mustTime(t, "2026-11-18T10:00:00Z")
	cases := []struct {
		name   string
		bucket formal.Bucket
		want   error
	}{
		{
			name:   "valid",
			bucket: formal.Bucket{Start: start, Total: 100, Errors: 1},
		},
		{
			name:   "errors exceed total",
			bucket: formal.Bucket{Start: start, Total: 10, Errors: 11},
			want:   formal.ErrInvalidBucket,
		},
		{
			name:   "negative total",
			bucket: formal.Bucket{Start: start, Total: -1},
			want:   formal.ErrInvalidBucket,
		},
		{
			name:   "zero start",
			bucket: formal.Bucket{},
			want:   formal.ErrInvalidBucket,
		},
		{
			name:   "misaligned",
			bucket: formal.Bucket{Start: start.Add(30 * time.Second), Total: 1},
			want:   formal.ErrBucketAlignment,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.bucket.Validate(time.Minute)
			if !errors.Is(err, tc.want) {
				t.Fatalf("Validate() error = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestStoreUpsertIsIdempotentAndOutOfOrder(t *testing.T) {
	store, err := formal.NewStore(time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	start := mustTime(t, "2026-11-18T10:00:00Z")

	changed, err := store.Upsert(formal.Bucket{Start: start.Add(2 * time.Minute), Total: 10, Errors: 1})
	if err != nil || !changed {
		t.Fatalf("first upsert changed=%v err=%v", changed, err)
	}
	changed, err = store.Upsert(formal.Bucket{Start: start, Total: 20, Errors: 2})
	if err != nil || !changed {
		t.Fatalf("out-of-order upsert changed=%v err=%v", changed, err)
	}

	revision := store.Revision()
	changed, err = store.Upsert(formal.Bucket{Start: start, Total: 20, Errors: 2})
	if err != nil || changed {
		t.Fatalf("duplicate upsert changed=%v err=%v", changed, err)
	}
	if store.Revision() != revision {
		t.Fatalf("duplicate changed revision from %d to %d", revision, store.Revision())
	}

	changed, err = store.Upsert(formal.Bucket{Start: start, Total: 20, Errors: 3})
	if err != nil || !changed {
		t.Fatalf("correction upsert changed=%v err=%v", changed, err)
	}
	if store.Revision() != revision+1 {
		t.Fatalf("correction revision = %d, want %d", store.Revision(), revision+1)
	}

	buckets := store.Buckets()
	if len(buckets) != 2 {
		t.Fatalf("bucket count = %d, want 2", len(buckets))
	}
	if !buckets[0].Start.Equal(start) || buckets[0].Errors != 3 {
		t.Fatalf("first bucket = %+v", buckets[0])
	}
}

func TestStoreDeleteAndPrune(t *testing.T) {
	store, _ := formal.NewStore(time.Minute)
	start := mustTime(t, "2026-11-18T10:00:00Z")
	for i := 0; i < 5; i++ {
		if _, err := store.Upsert(formal.Bucket{Start: start.Add(time.Duration(i) * time.Minute), Total: 1}); err != nil {
			t.Fatal(err)
		}
	}
	revision := store.Revision()
	if !store.Delete(start.Add(2 * time.Minute)) {
		t.Fatal("delete existing bucket returned false")
	}
	if store.Delete(start.Add(2 * time.Minute)) {
		t.Fatal("delete missing bucket returned true")
	}
	if store.Len() != 4 {
		t.Fatalf("len = %d, want 4", store.Len())
	}
	if removed := store.PruneBefore(start.Add(2 * time.Minute)); removed != 2 {
		t.Fatalf("pruned %d, want 2", removed)
	}
	if store.Revision() != revision+2 {
		t.Fatalf("revision = %d, want %d", store.Revision(), revision+2)
	}
}
