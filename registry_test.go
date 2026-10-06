package logcompact

import (
	"errors"
	"math/rand"
	"reflect"
	"sort"
	"testing"
)

// Stale release must not drop a reused slot's new pin (ABA protection).
func TestRegistryStaleRelease(t *testing.T) {
	reg := NewRegistry(1)

	h1, err := reg.Acquire(10)
	if err != nil {
		t.Fatalf("acquire h1: %v", err)
	}
	if err := reg.Release(h1); err != nil {
		t.Fatalf("release h1: %v", err)
	}
	// Slot is reused; the new handle gets a bumped generation.
	h2, err := reg.Acquire(20)
	if err != nil {
		t.Fatalf("acquire h2: %v", err)
	}
	if err := reg.Release(h1); !errors.Is(err, ErrStaleHandle) {
		t.Fatalf("stale release of h1: got %v, want ErrStaleHandle", err)
	}
	if got := reg.Snapshots(); !reflect.DeepEqual(got, []uint64{20}) {
		t.Fatalf("stale release dropped live pin, snapshots=%v", got)
	}
	if err := reg.Release(h2); err != nil {
		t.Fatalf("release h2: %v", err)
	}
	if got := reg.Snapshots(); len(got) != 0 {
		t.Fatalf("snapshots after release: %v", got)
	}
	// Double release is stale too.
	if err := reg.Release(h2); !errors.Is(err, ErrStaleHandle) {
		t.Fatalf("double release: got %v, want ErrStaleHandle", err)
	}
}

func TestRegistryFull(t *testing.T) {
	reg := NewRegistry(2)
	if _, err := reg.Acquire(1); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Acquire(2); err != nil {
		t.Fatal(err)
	}
	if _, err := reg.Acquire(3); !errors.Is(err, ErrRegistryFull) {
		t.Fatalf("got %v, want ErrRegistryFull", err)
	}
}

// Randomized acquire/release interleaving checked against a model set of
// live handles, including releases of already-released (stale) handles.
func TestRegistryRandomModel(t *testing.T) {
	for seed := int64(0); seed < 50; seed++ {
		r := rand.New(rand.NewSource(seed))
		reg := NewRegistry(4)
		live := map[Handle]uint64{} // handle -> snapshot
		var ever []Handle           // every handle ever issued (for stale releases)
		for i := 0; i < 2000; i++ {
			if r.Intn(2) == 0 || len(live) == 0 {
				snap := r.Uint64()
				h, err := reg.Acquire(snap)
				if len(live) == 4 {
					if !errors.Is(err, ErrRegistryFull) {
						t.Fatalf("seed %d: full registry acquire: %v", seed, err)
					}
					continue
				}
				if err != nil {
					t.Fatalf("seed %d: acquire: %v", seed, err)
				}
				if _, dup := live[h]; dup {
					t.Fatalf("seed %d: duplicate live handle %+v", seed, h)
				}
				live[h] = snap
				ever = append(ever, h)
			} else {
				h := ever[r.Intn(len(ever))]
				err := reg.Release(h)
				if _, ok := live[h]; ok {
					if err != nil {
						t.Fatalf("seed %d: release live handle: %v", seed, err)
					}
					delete(live, h)
				} else if !errors.Is(err, ErrStaleHandle) {
					t.Fatalf("seed %d: stale release: got %v", seed, err)
				}
			}
		}
		want := make([]uint64, 0, len(live))
		for _, snap := range live {
			want = append(want, snap)
		}
		got := reg.Snapshots()
		sort.Slice(want, func(i, j int) bool { return want[i] < want[j] })
		sort.Slice(got, func(i, j int) bool { return got[i] < got[j] })
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("seed %d: snapshots=%v want %v", seed, got, want)
		}
	}
}
