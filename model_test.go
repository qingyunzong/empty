package cache

import (
	"fmt"
	"math/rand"
	"slices"
	"testing"
)

// model is a deliberately simple reference implementation. It keeps no
// incremental invariants beyond what the operations themselves record, and
// recomputes eviction sets by scanning and sorting all pages on every
// insert. The real cache must agree with it after every single operation.
type mpage struct {
	value   int
	size    int64
	seq     uint64
	pins    int
	version uint64
}

type model struct {
	budget   int64
	used     int64
	seq      uint64
	pages    map[string]*mpage
	versions map[string]uint64
}

func newModel(budget int64) *model {
	return &model{
		budget:   budget,
		pages:    make(map[string]*mpage),
		versions: make(map[string]uint64),
	}
}

func (m *model) get(key string) (int, bool) {
	p, ok := m.pages[key]
	if !ok {
		return 0, false
	}
	m.seq++
	p.seq = m.seq
	return p.value, true
}

func (m *model) lease(key string) (*mpage, int, bool) {
	p, ok := m.pages[key]
	if !ok {
		return nil, 0, false
	}
	m.seq++
	p.seq = m.seq
	p.pins++
	return p, p.value, true
}

func (m *model) insert(key string, value int, size int64) error {
	usedAfter := m.used
	if old, ok := m.pages[key]; ok {
		usedAfter -= old.size
	}
	need := usedAfter + size - m.budget
	var evict []string
	if need > 0 {
		type candidate struct {
			key string
			p   *mpage
		}
		var cands []candidate
		for k, p := range m.pages {
			if k == key || p.pins > 0 {
				continue
			}
			cands = append(cands, candidate{k, p})
		}
		slices.SortFunc(cands, func(a, b candidate) int {
			switch {
			case a.p.seq < b.p.seq:
				return -1
			case a.p.seq > b.p.seq:
				return 1
			default:
				return 0
			}
		})
		var freed int64
		for _, cd := range cands {
			if freed >= need {
				break
			}
			evict = append(evict, cd.key)
			freed += cd.p.size
		}
		if freed < need {
			return ErrBudgetExhausted // no mutation: failed inserts are atomic
		}
	}
	if old, ok := m.pages[key]; ok {
		m.used -= old.size
		delete(m.pages, key)
	}
	for _, k := range evict {
		m.used -= m.pages[k].size
		delete(m.pages, k)
	}
	m.versions[key]++
	m.seq++
	m.pages[key] = &mpage{value: value, size: size, seq: m.seq, version: m.versions[key]}
	m.used += size
	return nil
}

func (m *model) invalidate(key string) {
	m.versions[key]++
	if p, ok := m.pages[key]; ok {
		m.used -= p.size
		delete(m.pages, key)
	}
}

// liveLease pairs a real lease with the model page it pins, so releases
// (including double and stale ones) can be replayed against the model.
type liveLease struct {
	key    string
	lease  *Lease[string, int]
	mp     *mpage
	active bool
}

func release(l *liveLease, m *model) {
	l.lease.Release()
	if !l.active {
		return // double release: no-op on both sides
	}
	l.active = false
	if p, ok := m.pages[l.key]; ok && p == l.mp && p.pins > 0 {
		p.pins--
	}
}

func TestRandomOpsAgainstModel(t *testing.T) {
	for seed := int64(0); seed < 5; seed++ {
		t.Run(fmt.Sprintf("seed=%d", seed), func(t *testing.T) {
			rnd := rand.New(rand.NewSource(seed))
			budget := int64(60 + rnd.Intn(90))
			c := New[string, int](budget)
			m := newModel(budget)
			keys := []string{"a", "b", "c", "d", "e", "f"}
			var leases []*liveLease

			for i := 0; i < 20000; i++ {
				key := keys[rnd.Intn(len(keys))]
				switch op := rnd.Intn(100); {
				case op < 30: // insert (sometimes oversized)
					size := int64(5 + rnd.Intn(45))
					if rnd.Intn(20) == 0 {
						size = budget + int64(1+rnd.Intn(50))
					}
					errC := c.Insert(key, i, size)
					errM := m.insert(key, i, size)
					if (errC == nil) != (errM == nil) {
						t.Fatalf("op %d: insert(%q,%d) cache err=%v, model err=%v", i, key, size, errC, errM)
					}
				case op < 55: // get
					vC, okC := c.Get(key)
					vM, okM := m.get(key)
					if okC != okM || (okC && vC != vM) {
						t.Fatalf("op %d: get(%q) cache=(%v,%v) model=(%v,%v)", i, key, vC, okC, vM, okM)
					}
				case op < 70: // lease
					vC, l, okC := c.Lease(key)
					mp, vM, okM := m.lease(key)
					if okC != okM || (okC && vC != vM) {
						t.Fatalf("op %d: lease(%q) cache=(%v,%v) model=(%v,%v)", i, key, vC, okC, vM, okM)
					}
					if okC {
						leases = append(leases, &liveLease{key: key, lease: l, mp: mp, active: true})
					}
				case op < 85: // release some lease (may be stale or double)
					if len(leases) > 0 {
						release(leases[rnd.Intn(len(leases))], m)
					}
				case op < 95: // invalidate
					c.Invalidate(key)
					m.invalidate(key)
				default: // release again: exercises double release
					if len(leases) > 0 {
						release(leases[rnd.Intn(len(leases))], m)
					}
				}
				checkState(t, i, c, m)
			}
		})
	}
}

// checkState compares the full observable and internal state of the cache
// against the model after every operation.
func checkState(t *testing.T, op int, c *Cache[string, int], m *model) {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.used != m.used {
		t.Fatalf("op %d: used cache=%d model=%d", op, c.used, m.used)
	}
	if c.reserved != 0 {
		t.Fatalf("op %d: reserved=%d, want 0 (no loads in this test)", op, c.reserved)
	}
	if c.seq != m.seq {
		t.Fatalf("op %d: seq cache=%d model=%d", op, c.seq, m.seq)
	}
	if len(c.pages) != len(m.pages) {
		t.Fatalf("op %d: page count cache=%d model=%d", op, len(c.pages), len(m.pages))
	}
	var sum int64
	for k, p := range c.pages {
		mp, ok := m.pages[k]
		if !ok {
			t.Fatalf("op %d: cache has page %q, model does not", op, k)
		}
		if p.value != mp.value || p.size != mp.size || p.seq != mp.seq ||
			p.pins != mp.pins || p.version != mp.version {
			t.Fatalf("op %d: page %q cache=%+v model=%+v", op, k, *p, *mp)
		}
		sum += p.size
	}
	if sum != c.used {
		t.Fatalf("op %d: used=%d but pages sum to %d", op, c.used, sum)
	}
	if len(c.versions) != len(m.versions) {
		t.Fatalf("op %d: version map size cache=%d model=%d", op, len(c.versions), len(m.versions))
	}
	for k, v := range c.versions {
		if m.versions[k] != v {
			t.Fatalf("op %d: version[%q] cache=%d model=%d", op, k, v, m.versions[k])
		}
	}
}
