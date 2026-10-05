package sigdb

import (
	"math/big"
	"sync"
)

// Store maintains a piecewise-linear signal keyed by timestamp. Range
// integrals are exact rationals served from a persistent, incremental index.
// Batches of corrections are published atomically; previously returned
// snapshots stay valid for old readers.
type Store struct {
	mu sync.Mutex
	pg *pager

	head *Snapshot
}

// Snapshot is an immutable, consistent view of samples and integrals as of
// one committed generation. Safe for concurrent reads.
type Snapshot struct {
	entries []entry
	root    *node
	gen     uint64
}

// Delta describes the local inverse difference a batch produced in the
// integral index: removed segments are subtracted, added segments inserted.
type Delta struct {
	Removed []segment
	Added   []segment
}

// Open opens (or creates) a store in dir and recovers the newest committed
// generation.
func Open(dir string) (*Store, error) {
	df, cf, err := openFiles(dir)
	if err != nil {
		return nil, err
	}
	return openStore(df, cf)
}

func openStore(data, commit rawFile) (*Store, error) {
	pg, err := openPager(data, commit)
	if err != nil {
		return nil, err
	}
	s := &Store{pg: pg}
	snap := &Snapshot{gen: pg.rec.gen}
	if pg.rec.samplesPg != 0 {
		buf, err := pg.readPage(pg.rec.samplesPg)
		if err != nil {
			return nil, err
		}
		if snap.entries, err = decodeEntries(buf); err != nil {
			return nil, err
		}
	}
	if pg.rec.indexRoot != 0 {
		root, err := s.loadNode(pg.rec.indexRoot)
		if err != nil {
			return nil, err
		}
		snap.root = root
	}
	s.head = snap
	return s, nil
}

func (s *Store) loadNode(id int64) (*node, error) {
	buf, err := s.pg.readPage(id)
	if err != nil {
		return nil, err
	}
	n, lp, rp, err := decodeNode(buf)
	if err != nil {
		return nil, err
	}
	n.page = id
	if lp != 0 {
		if n.left, err = s.loadNode(lp); err != nil {
			return nil, err
		}
	}
	if rp != 0 {
		if n.right, err = s.loadNode(rp); err != nil {
			return nil, err
		}
	}
	return recalc(n), nil
}

// Close flushes and closes the underlying files.
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.pg.close()
	return nil
}

// Head returns the newest committed Snapshot.
func (s *Store) Head() *Snapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.head
}

// Apply folds a batch of correction ops into the store and publishes the
// result atomically: all new index pages and the sample Snapshot become
// visible to new readers at once, and only after they are durable. Old
// snapshots are untouched. It returns the new Snapshot and the local index
// inverse difference the batch produced. A batch that changes nothing
// returns the current Snapshot and is not published.
func (s *Store) Apply(ops []Op) (*Snapshot, Delta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	newEntries, changed := applyOps(s.head.entries, ops)
	if len(changed) == 0 {
		return s.head, Delta{}, nil
	}
	removed, added := segmentDiff(s.head.entries, newEntries, changed)

	root := s.head.root
	for _, seg := range removed {
		root = remove(root, seg.t0)
	}
	for _, seg := range added {
		root = insert(root, seg)
	}

	// Persist: sample Snapshot page, then every new index page (post-order
	// so child page ids are known), then the atomic publish.
	samplesPg, err := s.pg.appendPage(encodeEntries(newEntries))
	if err != nil {
		return nil, Delta{}, err
	}
	var fresh []*node
	collectUnpersisted(root, &fresh)
	for _, n := range fresh {
		pg, err := s.pg.appendPage(encodeNode(n))
		if err != nil {
			return nil, Delta{}, err
		}
		n.page = pg
	}
	if err := s.pg.publish(samplesPg, root.pageID()); err != nil {
		return nil, Delta{}, err
	}

	snap := &Snapshot{entries: newEntries, root: root, gen: s.pg.rec.gen}
	s.head = snap
	return snap, Delta{Removed: removed, Added: added}, nil
}

// Integral returns the exact integral of the signal over [a, b] in this
// Snapshot, computed from the incremental index.
func (sn *Snapshot) Integral(a, b int64) *big.Rat {
	return sn.root.integral(a, b)
}

// Generation returns the committed generation of this Snapshot.
func (sn *Snapshot) Generation() uint64 { return sn.gen }

// Sample is the public view of one resolved entry.
type Sample struct {
	T       int64
	Version uint64
	Kind    Kind
	V       *big.Rat
}

// Samples returns the resolved entries (including missing markers and
// tombstones) in timestamp order.
func (sn *Snapshot) Samples() []Sample {
	out := make([]Sample, len(sn.entries))
	for i, e := range sn.entries {
		out[i] = Sample{T: e.t, Version: e.version, Kind: e.kind, V: e.v}
	}
	return out
}
