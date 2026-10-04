// Package workload drives a randomized fork/write/read/close history
// through both the copy-on-write store and the deep-copy reference model,
// asserting that every read agrees and that reference counts stay exact.
package workload

import (
	"bytes"
	"fmt"
	"math/rand"
	"sort"

	"pagesnap"
	"pagesnap/model"
)

// Config describes a randomized run.
type Config struct {
	Seed       int64  // PRNG seed; identical seeds reproduce identical runs
	Ops        int    // number of operations to generate
	MaxSnaps   int    // maximum simultaneously live snapshots
	MaxPages   uint64 // logical page numbers are drawn from [0, MaxPages)
	MaxWrite   int    // maximum bytes per write
	CloseAtEnd bool   // close all snapshots at the end and expect zero live pages
}

func (c Config) withDefaults() Config {
	if c.Ops <= 0 {
		c.Ops = 2000
	}
	if c.MaxSnaps <= 0 {
		c.MaxSnaps = 16
	}
	if c.MaxPages == 0 {
		c.MaxPages = 64
	}
	if c.MaxWrite <= 0 {
		c.MaxWrite = 512
	}
	return c
}

// Result summarizes a finished run.
type Result struct {
	Store *pagesnap.Store
	Stats pagesnap.Stats
	Live  []uint64 // snapshot IDs still open at the end (empty if CloseAtEnd)
}

type handle struct {
	snap *pagesnap.Snapshot
	mid  uint64 // model snapshot ID
}

// Run executes the workload and returns an error describing the first
// divergence from the reference model, or nil on success.
func Run(cfg Config) (Result, error) {
	cfg = cfg.withDefaults()
	rng := rand.New(rand.NewSource(cfg.Seed))
	store := pagesnap.NewStore()
	mdl := model.New()

	root := store.NewSnapshot()
	live := []handle{{snap: root, mid: mdl.NewSnapshot()}}

	step := 0
	fail := func(format string, args ...any) (Result, error) {
		return Result{Store: store}, fmt.Errorf("step %d: %s", step, fmt.Sprintf(format, args...))
	}

	for ; step < cfg.Ops; step++ {
		// Refcounts must be exact after every single operation.
		if err := store.VerifyRefCounts(); err != nil {
			return fail("refcount invariant broken: %v", err)
		}
		op := rng.Intn(100)
		switch {
		case op < 25 && len(live) < cfg.MaxSnaps:
			// Fork a random live snapshot.
			src := live[rng.Intn(len(live))]
			child, err := src.snap.Fork()
			if err != nil {
				return fail("fork: %v", err)
			}
			mid, err := mdl.Fork(src.mid)
			if err != nil {
				return fail("model fork: %v", err)
			}
			live = append(live, handle{snap: child, mid: mid})
		case op < 70:
			// Write random data to a random page of a random snapshot.
			h := live[rng.Intn(len(live))]
			page := uint64(rng.Intn(int(cfg.MaxPages)))
			n := 1 + rng.Intn(cfg.MaxWrite)
			data := make([]byte, n)
			rng.Read(data)
			if err := h.snap.Write(page, data); err != nil {
				return fail("write snap=%d page=%d: %v", h.snap.ID(), page, err)
			}
			if err := mdl.Write(h.mid, page, data); err != nil {
				return fail("model write: %v", err)
			}
		case op < 90:
			// Read a random page and compare against the model.
			h := live[rng.Intn(len(live))]
			page := uint64(rng.Intn(int(cfg.MaxPages)))
			if err := compareRead(h.snap, mdl, h.mid, page); err != nil {
				return fail("snap=%d: %v", h.snap.ID(), err)
			}
		default:
			// Close a random snapshot, always keeping at least one live.
			if len(live) <= 1 {
				continue
			}
			i := rng.Intn(len(live))
			h := live[i]
			if err := h.snap.Close(); err != nil {
				return fail("close snap=%d: %v", h.snap.ID(), err)
			}
			if err := mdl.Close(h.mid); err != nil {
				return fail("model close: %v", err)
			}
			live = append(live[:i], live[i+1:]...)
		}
	}

	// Full final comparison: every live snapshot, every logical page.
	for _, h := range live {
		if err := compareSnapshot(h.snap, mdl, h.mid); err != nil {
			return fail("final compare snap=%d: %v", h.snap.ID(), err)
		}
	}

	res := Result{Store: store}
	if cfg.CloseAtEnd {
		for _, h := range live {
			if err := h.snap.Close(); err != nil {
				return fail("final close: %v", err)
			}
			if err := mdl.Close(h.mid); err != nil {
				return fail("model final close: %v", err)
			}
		}
		if err := store.VerifyRefCounts(); err != nil {
			return fail("post-close refcount invariant broken: %v", err)
		}
		stats := store.Stats()
		if stats.LivePages != 0 {
			return fail("post-close: %d physical pages leaked", stats.LivePages)
		}
		if stats.LiveSnapshots != 0 {
			return fail("post-close: %d snapshots still live", stats.LiveSnapshots)
		}
	} else {
		res.Live = make([]uint64, 0, len(live))
		for _, h := range live {
			res.Live = append(res.Live, h.snap.ID())
		}
		sort.Slice(res.Live, func(i, j int) bool { return res.Live[i] < res.Live[j] })
	}
	res.Stats = store.Stats()
	return res, nil
}

func compareRead(snap *pagesnap.Snapshot, mdl *model.Model, mid, page uint64) error {
	got, err := snap.Read(page)
	if err != nil {
		return fmt.Errorf("read page=%d: %v", page, err)
	}
	want, err := mdl.Read(mid, page)
	if err != nil {
		return fmt.Errorf("model read page=%d: %v", page, err)
	}
	if !bytes.Equal(got, want) {
		return fmt.Errorf("read page=%d diverged from model", page)
	}
	return nil
}

func compareSnapshot(snap *pagesnap.Snapshot, mdl *model.Model, mid uint64) error {
	gotPages, err := snap.LogicalPages()
	if err != nil {
		return err
	}
	wantPages, err := mdl.LogicalPages(mid)
	if err != nil {
		return err
	}
	if len(gotPages) != len(wantPages) {
		return fmt.Errorf("logical page count %d, want %d", len(gotPages), len(wantPages))
	}
	for i := range gotPages {
		if gotPages[i] != wantPages[i] {
			return fmt.Errorf("logical page set diverged at index %d: %d != %d", i, gotPages[i], wantPages[i])
		}
		if err := compareRead(snap, mdl, mid, gotPages[i]); err != nil {
			return err
		}
	}
	return nil
}
