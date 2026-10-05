// Package monitor maintains piecewise-linear signals keyed by timestamp
// and answers exact rational range integrals. A Store persists an
// incremental integral index as immutable pages: every commit publishes a
// new root atomically, corrections rewrite only the pages whose covered
// intervals changed, and snapshots keep old generations readable.
package monitor

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"math/big"
	"os"
	"sync"
)

// Options tunes the paged index layout.
type Options struct {
	LeafCapacity     int // max samples per leaf page
	InternalCapacity int // max children per internal page
}

func (o *Options) withDefaults() {
	if o.LeafCapacity <= 0 {
		o.LeafCapacity = 64
	}
	if o.InternalCapacity < 2 {
		o.InternalCapacity = 64
	}
}

// CommitStats describes one published generation. Delta is the local
// inverse interval delta produced by the batch: new minus old total
// aggregate. PagesWritten shows how localized the update was.
type CommitStats struct {
	Generation   uint64
	PagesWritten int
	Delta        *big.Rat
}

// Store is a persistent, crash-safe incremental integral index.
type Store struct {
	f    *os.File
	opts Options

	mu       sync.RWMutex
	samples  []Sample
	root     uint64 // 0 means empty
	gen      uint64
	nextPage uint64
	live     map[string]uint64 // content hash -> page, for page reuse

	// FailHook, when non-nil, runs before every write and sync inside
	// Commit; returning an error simulates a power loss at that exact
	// point. op is "page", "sync" or "root".
	FailHook func(op string, page uint64) error

	// LastCommit holds stats of the most recent successful Commit.
	LastCommit CommitStats
}

// Open creates or recovers the index at path.
func Open(path string, opts Options) (*Store, error) {
	opts.withDefaults()
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	s := &Store{f: f, opts: opts, nextPage: 1, live: map[string]uint64{}}
	if err := s.recover(); err != nil {
		f.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) Close() error { return s.f.Close() }

func (s *Store) recover() error {
	st, err := s.f.Stat()
	if err != nil {
		return err
	}
	if st.Size() < pageSize {
		sb := make([]byte, pageSize)
		copy(sb, magic[:])
		binary.LittleEndian.PutUint32(sb[8:], pageSize)
		copy(sb[superSlotOff:], encodeSlot(superSlot{}))
		copy(sb[superSlotOff+superSlotSize:], encodeSlot(superSlot{}))
		if _, err := s.f.WriteAt(sb, 0); err != nil {
			return err
		}
		return s.f.Sync()
	}
	sb := make([]byte, pageSize)
	if _, err := s.f.ReadAt(sb, 0); err != nil {
		return err
	}
	if !bytes.Equal(sb[:8], magic[:]) {
		return errors.New("monitor: bad magic")
	}
	var best superSlot
	for i := 0; i < 2; i++ {
		slot, ok := decodeSlot(sb[superSlotOff+i*superSlotSize:])
		if !ok {
			continue
		}
		if slot.root != 0 && slot.root >= slot.numPages {
			continue
		}
		if int64(slot.numPages)*pageSize > st.Size() {
			continue
		}
		if slot.gen >= best.gen {
			best = slot
		}
	}
	s.gen = best.gen
	s.root = best.root
	s.nextPage = best.numPages
	if s.nextPage < 1 {
		s.nextPage = 1
	}
	if s.root != 0 {
		samples, err := s.collectSamples(s.root)
		if err != nil {
			return err
		}
		s.samples = samples
		return s.indexLive(s.root)
	}
	return nil
}

// Commit applies the whole batch and publishes it as one generation.
// Readers holding older snapshots are unaffected. If FailHook aborts the
// commit, the previously published generation remains the durable state.
func (s *Store) Commit(ops ...Op) (CommitStats, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	oldSamples := cloneSamples(s.samples)
	s.samples = applyOps(s.samples, ops)

	stats, err := s.commitLocked()
	if err != nil {
		s.samples = oldSamples
		return CommitStats{}, err
	}
	s.LastCommit = stats
	return stats, nil
}

func (s *Store) commitLocked() (CommitStats, error) {
	oldTotal, err := s.rootTotal()
	if err != nil {
		return CommitStats{}, err
	}

	type pending struct {
		page uint64
		data []byte
	}
	var writes []pending
	newLive := map[string]uint64{}
	alloc := func(data []byte) uint64 {
		full := make([]byte, pageSize)
		copy(full, data)
		h := hashPage(full)
		if p, ok := newLive[h]; ok {
			return p
		}
		if p, ok := s.live[h]; ok {
			newLive[h] = p
			return p
		}
		p := s.nextPage
		s.nextPage++
		writes = append(writes, pending{page: p, data: full})
		newLive[h] = p
		return p
	}

	root, newTotal, err := s.buildTree(alloc)
	if err != nil {
		return CommitStats{}, err
	}

	// 1. Flush every dirty index page, then fsync. These pages are
	// unreachable until the root slot names them.
	for _, w := range writes {
		if s.FailHook != nil {
			if err := s.FailHook("page", w.page); err != nil {
				return CommitStats{}, err
			}
		}
		if _, err := s.f.WriteAt(w.data, int64(w.page)*pageSize); err != nil {
			return CommitStats{}, err
		}
	}
	if s.FailHook != nil {
		if err := s.FailHook("sync", 0); err != nil {
			return CommitStats{}, err
		}
	}
	if err := s.f.Sync(); err != nil {
		return CommitStats{}, err
	}

	// 2. Publish the new root in the alternating superblock slot. The
	// CRC guards against torn writes, so a crash here either keeps the
	// old generation or activates the new one, never a mix.
	newGen := s.gen + 1
	slot := encodeSlot(superSlot{gen: newGen, root: root, numPages: s.nextPage})
	off := int64(superSlotOff + int(newGen%2)*superSlotSize)
	if s.FailHook != nil {
		if err := s.FailHook("root", 0); err != nil {
			return CommitStats{}, err
		}
	}
	if _, err := s.f.WriteAt(slot, off); err != nil {
		return CommitStats{}, err
	}
	if err := s.f.Sync(); err != nil {
		return CommitStats{}, err
	}

	s.root = root
	s.gen = newGen
	s.live = newLive
	return CommitStats{
		Generation:   newGen,
		PagesWritten: len(writes),
		Delta:        new(big.Rat).Sub(newTotal, oldTotal),
	}, nil
}

// buildTree lays the sorted samples out into leaf pages and rolls
// aggregates up through internal levels. alloc assigns page numbers,
// reusing any existing page with identical content.
func (s *Store) buildTree(alloc func([]byte) uint64) (uint64, *big.Rat, error) {
	if len(s.samples) == 0 {
		return 0, new(big.Rat), nil
	}
	type nodeInfo struct {
		page   uint64
		minT   int64
		segEnd int64
		agg    *big.Rat
	}
	var level []nodeInfo
	cap := s.opts.LeafCapacity
	for i := 0; i < len(s.samples); i += cap {
		j := min(i+cap, len(s.samples))
		entries := s.samples[i:j]
		leaf := &leafData{entries: entries, agg: new(big.Rat)}
		for k := range entries {
			var t2 int64
			var v2 *big.Rat
			missing2 := false
			switch {
			case k+1 < len(entries):
				nx := entries[k+1]
				t2, v2, missing2 = nx.Time, nx.Value, nx.Missing
			case j < len(s.samples):
				nx := s.samples[j]
				leaf.next = &nx
				t2, v2, missing2 = nx.Time, nx.Value, nx.Missing
			default:
				continue
			}
			if entries[k].Missing || missing2 {
				continue
			}
			leaf.agg.Add(leaf.agg, segIntegral(entries[k].Time, entries[k].Value, t2, v2))
		}
		data, err := encodeLeaf(leaf)
		if err != nil {
			return 0, nil, err
		}
		segEnd := entries[len(entries)-1].Time
		if leaf.next != nil {
			segEnd = leaf.next.Time
		}
		level = append(level, nodeInfo{page: alloc(data), minT: entries[0].Time, segEnd: segEnd, agg: leaf.agg})
	}
	for len(level) > 1 {
		var next []nodeInfo
		icap := s.opts.InternalCapacity
		for i := 0; i < len(level); i += icap {
			j := min(i+icap, len(level))
			grp := level[i:j]
			ip := &internalData{children: make([]childEntry, len(grp))}
			agg := new(big.Rat)
			for k, g := range grp {
				ip.children[k] = childEntry{page: g.page, minT: g.minT, segEnd: g.segEnd, agg: g.agg}
				agg.Add(agg, g.agg)
			}
			data, err := encodeInternal(ip)
			if err != nil {
				return 0, nil, err
			}
			next = append(next, nodeInfo{page: alloc(data), minT: grp[0].minT, segEnd: grp[len(grp)-1].segEnd, agg: agg})
		}
		level = next
	}
	return level[0].page, level[0].agg, nil
}

func hashPage(b []byte) string {
	sum := sha256.Sum256(b)
	return string(sum[:])
}

func (s *Store) readPageRaw(page uint64) ([]byte, error) {
	buf := make([]byte, pageSize)
	if _, err := s.f.ReadAt(buf, int64(page)*pageSize); err != nil {
		return nil, err
	}
	return buf, nil
}

func (s *Store) collectSamples(page uint64) ([]Sample, error) {
	raw, err := s.readPageRaw(page)
	if err != nil {
		return nil, err
	}
	switch raw[0] {
	case pageLeaf:
		l, err := decodeLeaf(&decoder{data: raw, off: 1})
		if err != nil {
			return nil, err
		}
		return l.entries, nil
	case pageInternal:
		p, err := decodeInternal(&decoder{data: raw, off: 1})
		if err != nil {
			return nil, err
		}
		var out []Sample
		for _, c := range p.children {
			cs, err := s.collectSamples(c.page)
			if err != nil {
				return nil, err
			}
			out = append(out, cs...)
		}
		return out, nil
	}
	return nil, errCorrupt
}

func (s *Store) indexLive(page uint64) error {
	raw, err := s.readPageRaw(page)
	if err != nil {
		return err
	}
	s.live[hashPage(raw)] = page
	if raw[0] == pageInternal {
		p, err := decodeInternal(&decoder{data: raw, off: 1})
		if err != nil {
			return err
		}
		for _, c := range p.children {
			if err := s.indexLive(c.page); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Store) rootTotal() (*big.Rat, error) {
	if s.root == 0 {
		return new(big.Rat), nil
	}
	raw, err := s.readPageRaw(s.root)
	if err != nil {
		return nil, err
	}
	switch raw[0] {
	case pageLeaf:
		l, err := decodeLeaf(&decoder{data: raw, off: 1})
		if err != nil {
			return nil, err
		}
		return l.agg, nil
	case pageInternal:
		p, err := decodeInternal(&decoder{data: raw, off: 1})
		if err != nil {
			return nil, err
		}
		total := new(big.Rat)
		for _, c := range p.children {
			total.Add(total, c.agg)
		}
		return total, nil
	}
	return nil, errCorrupt
}

func (s *Store) queryPage(page uint64, a, b int64, total *big.Rat) error {
	raw, err := s.readPageRaw(page)
	if err != nil {
		return err
	}
	switch raw[0] {
	case pageLeaf:
		l, err := decodeLeaf(&decoder{data: raw, off: 1})
		if err != nil {
			return err
		}
		for k := 0; k < len(l.entries); k++ {
			s1 := l.entries[k]
			var s2 Sample
			switch {
			case k+1 < len(l.entries):
				s2 = l.entries[k+1]
			case l.next != nil:
				s2 = *l.next
			default:
				continue
			}
			if s1.Missing || s2.Missing {
				continue
			}
			total.Add(total, segIntegralClipped(s1.Time, s1.Value, s2.Time, s2.Value, a, b))
		}
		return nil
	case pageInternal:
		p, err := decodeInternal(&decoder{data: raw, off: 1})
		if err != nil {
			return err
		}
		for _, c := range p.children {
			if c.segEnd < a || c.minT > b {
				continue
			}
			if c.minT >= a && c.segEnd <= b {
				total.Add(total, c.agg)
				continue
			}
			if err := s.queryPage(c.page, a, b, total); err != nil {
				return err
			}
		}
		return nil
	}
	return errCorrupt
}

func (s *Store) integralFrom(root uint64, a, b int64) (*big.Rat, error) {
	total := new(big.Rat)
	if root == 0 || a >= b {
		return total, nil
	}
	if err := s.queryPage(root, a, b, total); err != nil {
		return nil, err
	}
	return total, nil
}

// Integral returns the exact rational integral of the current published
// generation over [a,b].
func (s *Store) Integral(a, b int64) (*big.Rat, error) {
	s.mu.RLock()
	root := s.root
	s.mu.RUnlock()
	return s.integralFrom(root, a, b)
}

// Samples returns the current published sample list.
func (s *Store) Samples() []Sample {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return cloneSamples(s.samples)
}

// Generation returns the current published generation.
func (s *Store) Generation() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.gen
}

// Snapshot is a retained read view of one published generation. Its
// pages are immutable, so later commits never disturb it.
type Snapshot struct {
	s    *Store
	root uint64
	gen  uint64
}

func (s *Store) Snapshot() *Snapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return &Snapshot{s: s, root: s.root, gen: s.gen}
}

func (sn *Snapshot) Generation() uint64 { return sn.gen }

func (sn *Snapshot) Integral(a, b int64) (*big.Rat, error) {
	return sn.s.integralFrom(sn.root, a, b)
}

func (sn *Snapshot) Samples() ([]Sample, error) {
	if sn.root == 0 {
		return nil, nil
	}
	return sn.s.collectSamples(sn.root)
}
