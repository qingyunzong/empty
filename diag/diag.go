// Package diag drives a cowpage.Store through a randomized history of
// branch creations, forks, writes, reads and deletions, checking every
// observable state against an independent deep-copy reference model.
package diag

import (
	"bytes"
	"fmt"
	"math/rand"
	"sort"

	"pagestore/cowpage"
)

// Config tunes a randomized run.
type Config struct {
	Seed        int64
	Ops         int // number of random operations
	NumPages    int // logical pages per branch
	PageSize    int // bytes per page
	MaxBranches int // cap on simultaneously live branches
	Verbose     bool
	Logf        func(format string, args ...any) // optional progress logger
}

// Stats summarizes a finished run.
type Stats struct {
	Ops           int
	Creates       int
	Forks         int
	Writes        int
	Reads         int
	Deletes       int
	FullChecks    int
	PeakBranches  int
	PeakLivePages int
}

// model is the deep-copy reference: every branch owns a full private copy
// of its address space, so forking copies bytes and nothing is shared.
type model struct {
	numPages int
	pageSize int
	next     int
	views    map[int][][]byte
}

func newModel(numPages, pageSize int) *model {
	return &model{numPages: numPages, pageSize: pageSize, views: make(map[int][][]byte)}
}

func blank(numPages, pageSize int) [][]byte {
	v := make([][]byte, numPages)
	for i := range v {
		v[i] = make([]byte, pageSize)
	}
	return v
}

func deepCopy(v [][]byte) [][]byte {
	out := make([][]byte, len(v))
	for i, p := range v {
		cp := make([]byte, len(p))
		copy(cp, p)
		out[i] = cp
	}
	return out
}

func (m *model) create() int {
	id := m.next
	m.next++
	m.views[id] = blank(m.numPages, m.pageSize)
	return id
}

func (m *model) fork(src int) int {
	id := m.next
	m.next++
	m.views[id] = deepCopy(m.views[src])
	return id
}

func (m *model) delete(id int) { delete(m.views, id) }

// Run executes the randomized workload and verifies the store against the
// deep-copy model after every operation. It returns an error describing the
// first divergence or invariant violation, if any.
func Run(cfg Config) (*Stats, error) {
	if cfg.Ops <= 0 {
		cfg.Ops = 1000
	}
	if cfg.NumPages <= 0 {
		cfg.NumPages = 32
	}
	if cfg.PageSize <= 0 {
		cfg.PageSize = 64
	}
	if cfg.MaxBranches <= 0 {
		cfg.MaxBranches = 16
	}
	logf := cfg.Logf
	if logf == nil {
		logf = func(string, ...any) {}
	}

	rng := rand.New(rand.NewSource(cfg.Seed))
	store := cowpage.New(cfg.NumPages, cfg.PageSize)
	mdl := newModel(cfg.NumPages, cfg.PageSize)
	st := &Stats{}

	// Paired handles: store branch i corresponds to model view i because
	// both allocators hand out sequential IDs starting at 0.
	live := []int{}

	create := func() {
		id := int(store.Create())
		mid := mdl.create()
		if id != mid {
			panic(fmt.Sprintf("handle divergence: store=%d model=%d", id, mid))
		}
		live = append(live, id)
		st.Creates++
		if len(live) > st.PeakBranches {
			st.PeakBranches = len(live)
		}
	}

	// checkAll compares every live branch, page by page, with the model.
	checkAll := func(op string) error {
		st.FullChecks++
		for _, id := range live {
			for p := 0; p < cfg.NumPages; p++ {
				got, err := store.Read(cowpage.BranchID(id), p)
				if err != nil {
					return fmt.Errorf("op %d (%s): read branch %d page %d: %w", st.Ops, op, id, p, err)
				}
				if want := mdl.views[id][p]; !bytes.Equal(got, want) {
					return fmt.Errorf("op %d (%s): branch %d page %d diverged from deep-copy model\n got: %x\nwant: %x", st.Ops, op, id, p, got, want)
				}
			}
		}
		if err := store.Validate(); err != nil {
			return fmt.Errorf("op %d (%s): refcount invariant: %w", st.Ops, op, err)
		}
		if n := store.LivePages(); n > st.PeakLivePages {
			st.PeakLivePages = n
		}
		return nil
	}

	create() // ensure at least one branch exists

	for st.Ops < cfg.Ops {
		st.Ops++
		// Weighted op choice.
		roll := rng.Intn(100)
		switch {
		case roll < 20 && len(live) < cfg.MaxBranches:
			src := live[rng.Intn(len(live))]
			sid, err := store.Fork(cowpage.BranchID(src))
			if err != nil {
				return st, fmt.Errorf("op %d: fork branch %d: %w", st.Ops, src, err)
			}
			mid := mdl.fork(src)
			if int(sid) != mid {
				return st, fmt.Errorf("op %d: fork handle divergence: store=%d model=%d", st.Ops, sid, mid)
			}
			live = append(live, int(sid))
			st.Forks++
			if len(live) > st.PeakBranches {
				st.PeakBranches = len(live)
			}
			if cfg.Verbose {
				logf("op %d: fork %d -> %d", st.Ops, src, sid)
			}
			if err := checkAll("fork"); err != nil {
				return st, err
			}

		case roll < 60:
			id := live[rng.Intn(len(live))]
			page := rng.Intn(cfg.NumPages)
			off := rng.Intn(cfg.PageSize)
			n := 1 + rng.Intn(cfg.PageSize-off)
			data := make([]byte, n)
			rng.Read(data)
			if err := store.Write(cowpage.BranchID(id), page, off, data); err != nil {
				return st, fmt.Errorf("op %d: write branch %d page %d: %w", st.Ops, id, page, err)
			}
			copy(mdl.views[id][page][off:], data)
			st.Writes++
			if cfg.Verbose {
				logf("op %d: write branch %d page %d off %d len %d", st.Ops, id, page, off, n)
			}
			if err := checkAll("write"); err != nil {
				return st, err
			}

		case roll < 80:
			id := live[rng.Intn(len(live))]
			page := rng.Intn(cfg.NumPages)
			got, err := store.Read(cowpage.BranchID(id), page)
			if err != nil {
				return st, fmt.Errorf("op %d: read branch %d page %d: %w", st.Ops, id, page, err)
			}
			if want := mdl.views[id][page]; !bytes.Equal(got, want) {
				return st, fmt.Errorf("op %d: branch %d page %d read diverged\n got: %x\nwant: %x", st.Ops, id, page, got, want)
			}
			st.Reads++

		case len(live) > 1:
			i := rng.Intn(len(live))
			id := live[i]
			if err := store.Delete(cowpage.BranchID(id)); err != nil {
				return st, fmt.Errorf("op %d: delete branch %d: %w", st.Ops, id, err)
			}
			mdl.delete(id)
			live = append(live[:i], live[i+1:]...)
			st.Deletes++
			if cfg.Verbose {
				logf("op %d: delete branch %d", st.Ops, id)
			}
			if err := checkAll("delete"); err != nil {
				return st, err
			}

		default:
			create()
			if err := checkAll("create"); err != nil {
				return st, err
			}
		}
	}

	// Teardown: deleting every branch must return all references; only the
	// store-owned zero page may survive, and Close must release that too.
	remaining := append([]int(nil), live...)
	sort.Ints(remaining)
	for _, id := range remaining {
		if err := store.Delete(cowpage.BranchID(id)); err != nil {
			return st, fmt.Errorf("teardown: delete branch %d: %w", id, err)
		}
		mdl.delete(id)
		st.Deletes++
	}
	if err := store.Validate(); err != nil {
		return st, fmt.Errorf("teardown: refcount invariant: %w", err)
	}
	if n := store.LivePages(); n != 1 {
		return st, fmt.Errorf("teardown: %d live pages after deleting all branches, want 1 (zero page)", n)
	}
	store.Close()
	if n := store.LivePages(); n != 0 {
		return st, fmt.Errorf("teardown: %d live pages after Close, want 0 (leak)", n)
	}
	return st, nil
}
