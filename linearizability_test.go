package formal

import (
	"fmt"
	"math/rand"
	"sync"
	"testing"
)

// TestConcurrentHistoryIsLinearizable drives the gateway from several
// goroutines that upload, overwrite, complete and read the same key, then
// verifies the recorded operation history against the sequential
// specification. Passing means every observed object was exactly the
// concatenation of one committed manifest.
func TestConcurrentHistoryIsLinearizable(t *testing.T) {
	rec := NewRecorder(NewGateway())
	const key = "obj"

	var wg sync.WaitGroup
	// Two upload workers race on the same key, including overwrites and
	// idempotent re-uploads.
	for w := 0; w < 2; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			rng := rand.New(rand.NewSource(int64(w) + 1))
			id := rec.BeginUpload(key)
			gens := make(map[int]uint64)
			parts := make(map[int][]byte)
			for i := 0; i < 8; i++ {
				num := 1 + rng.Intn(3)
				data := []byte(fmt.Sprintf("w%di%d", w, i))
				offset := int64(4 * (num - 1))
				spec := PartSpec{Number: num, Offset: offset, Digest: DigestOf(data)}
				gen, err := rec.PutPart(id, spec, data)
				if err != nil {
					continue
				}
				gens[num] = gen
				parts[num] = data
				// Occasionally re-upload the same digest (idempotent).
				if rng.Intn(3) == 0 {
					rec.PutPart(id, spec, data)
				}
			}
			var manifest []PartRef
			for num := 1; num <= 3; num++ {
				data, ok := parts[num]
				if !ok {
					continue
				}
				manifest = append(manifest, PartRef{
					Number: num,
					Gen:    gens[num],
					Offset: int64(4 * (num - 1)),
					Size:   int64(len(data)),
					Digest: DigestOf(data),
				})
			}
			if len(manifest) == 3 {
				rec.Complete(id, manifest)
			}
		}(w)
	}
	// One reader polls the object concurrently.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 10; i++ {
			rec.GetObject(key)
		}
	}()
	wg.Wait()

	history := rec.History()
	if !CheckLinearizable(history) {
		t.Fatalf("history of %d events is not linearizable", len(history))
	}
}

// TestCheckerRejectsFabricatedRead is a negative control: a history whose
// read returns bytes no committed manifest could have produced must be
// rejected by the checker.
func TestCheckerRejectsFabricatedRead(t *testing.T) {
	rec := NewRecorder(NewGateway())
	id := rec.BeginUpload("k")
	data := []byte("real")
	gen, err := rec.PutPart(id, PartSpec{Number: 1, Offset: 0, Digest: DigestOf(data)}, data)
	if err != nil {
		t.Fatal(err)
	}
	manifest := []PartRef{{Number: 1, Gen: gen, Offset: 0, Size: int64(len(data)), Digest: DigestOf(data)}}
	if _, err := rec.Complete(id, manifest); err != nil {
		t.Fatal(err)
	}
	if _, _, ok := rec.GetObject("k"); !ok {
		t.Fatal("expected object to be visible")
	}

	good := rec.History()
	if !CheckLinearizable(good) {
		t.Fatal("valid history rejected")
	}

	// Corrupt the final read: bytes that were never committed.
	bad := make([]*Event, len(good))
	copy(bad, good)
	forged := *bad[len(bad)-1]
	forged.Object = []byte("forged")
	bad[len(bad)-1] = &forged
	if CheckLinearizable(bad) {
		t.Fatal("checker accepted a read of never-committed bytes")
	}
}
