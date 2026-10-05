package mirror

import (
	"crypto/sha256"
	"encoding/binary"
	"sort"
	"sync"
)

// Mirror is a versioned block repository. Every mutation bumps the
// version and rebuilds the published hash tree, so a tree always
// corresponds to exactly one version of the content.
type Mirror struct {
	mu      sync.Mutex
	blocks  [][]byte // nil means the leaf is missing
	version uint64
	tree    *Tree

	// OnRead, if set, runs inside ReadBlock. Tests use it to inject
	// concurrent modifications.
	OnRead func()
}

// NewMirror creates an empty repository with n blocks.
func NewMirror(n int) *Mirror {
	m := &Mirror{blocks: make([][]byte, n)}
	m.rebuildLocked()
	return m
}

func (m *Mirror) rebuildLocked() {
	n := len(m.blocks)
	m.tree = BuildTree(n, func(i int) ([]byte, bool) {
		if m.blocks[i] == nil {
			return nil, false
		}
		return m.blocks[i], true
	})
}

// NumBlocks returns the fixed block count of the repository.
func (m *Mirror) NumBlocks() int { return len(m.blocks) }

// Version returns the current content version.
func (m *Mirror) Version() uint64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.version
}

// Tree returns the hash tree published for the current version.
func (m *Mirror) Tree() *Tree {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.tree
}

// ReadBlock returns a copy of block i. ok is false for a missing leaf.
func (m *Mirror) ReadBlock(i int) (data []byte, ok bool) {
	if m.OnRead != nil {
		m.OnRead()
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.blocks[i] == nil {
		return nil, false
	}
	out := make([]byte, BlockSize)
	copy(out, m.blocks[i])
	return out, true
}

// WriteBlock publishes block i and bumps the version.
func (m *Mirror) WriteBlock(i int, data []byte) {
	if len(data) != BlockSize {
		panic("mirror: block has wrong length")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	cp := make([]byte, BlockSize)
	copy(cp, data)
	m.blocks[i] = cp
	m.version++
	m.rebuildLocked()
}

// ClearBlock removes leaf i (making it missing) and bumps the version.
func (m *Mirror) ClearBlock(i int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.blocks[i] = nil
	m.version++
	m.rebuildLocked()
}

// Digest returns a full-content digest covering every leaf, with
// missing leaves and all-zero leaves encoded distinctly.
func (m *Mirror) Digest() [32]byte {
	m.mu.Lock()
	defer m.mu.Unlock()
	h := sha256.New()
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(len(m.blocks)))
	h.Write(buf[:])
	for _, b := range m.blocks {
		if b == nil {
			h.Write([]byte{tagMissing})
		} else {
			h.Write([]byte{tagLeaf})
			h.Write(b)
		}
	}
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

// Source is the read side of a repository during repair.
type Source interface {
	Version() uint64
	Tree() *Tree
	ReadBlock(i int) (data []byte, ok bool)
}

// CountingSource wraps a Source and records every block read, so tests
// can verify that repair only touches the differing leaves.
type CountingSource struct {
	Src   Source
	reads map[int]int
}

// NewCountingSource wraps src with read accounting.
func NewCountingSource(src Source) *CountingSource {
	return &CountingSource{Src: src, reads: map[int]int{}}
}

func (c *CountingSource) Version() uint64 { return c.Src.Version() }
func (c *CountingSource) Tree() *Tree     { return c.Src.Tree() }

func (c *CountingSource) ReadBlock(i int) ([]byte, bool) {
	c.reads[i]++
	return c.Src.ReadBlock(i)
}

// Accessed returns the sorted set of blocks read so far.
func (c *CountingSource) Accessed() []int {
	out := make([]int, 0, len(c.reads))
	for i := range c.reads {
		out = append(out, i)
	}
	sort.Ints(out)
	return out
}

// Ranges returns the accessed blocks merged into [start, end) ranges.
func (c *CountingSource) Ranges() [][2]int {
	acc := c.Accessed()
	var ranges [][2]int
	for _, i := range acc {
		if n := len(ranges); n > 0 && i == ranges[n-1][1] {
			ranges[n-1][1] = i + 1
		} else {
			ranges = append(ranges, [2]int{i, i + 1})
		}
	}
	return ranges
}
