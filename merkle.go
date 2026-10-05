package mirror

import (
	"crypto/sha256"
	"encoding/binary"
)

// BlockSize is the fixed length of every block in the repository.
const BlockSize = 4096

// Domain separators keep missing leaves, present leaves (including
// all-zero leaves) and interior nodes in distinct hash domains.
const (
	tagMissing byte = 0x00
	tagLeaf    byte = 0x01
	tagNode    byte = 0x02
)

// missingLeafHash is the hash of an absent leaf at index i. It differs
// from the hash of any present leaf, including an all-zero block.
func missingLeafHash(i int) [32]byte {
	h := sha256.New()
	h.Write([]byte{tagMissing})
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], uint64(i))
	h.Write(buf[:])
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

// leafHash hashes a present block. data must be exactly BlockSize bytes;
// an all-zero block therefore hashes differently from a missing leaf.
func leafHash(data []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte{tagLeaf})
	h.Write(data)
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

func nodeHash(left, right [32]byte) [32]byte {
	h := sha256.New()
	h.Write([]byte{tagNode})
	h.Write(left[:])
	h.Write(right[:])
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

// Tree is a Merkle tree over a fixed number of fixed-length leaves.
// levels[0] holds leaf hashes, levels[len-1] holds the root.
type Tree struct {
	levels [][][32]byte
	nleaf  int // logical leaf count (before power-of-two padding)
}

// BuildTree builds a Merkle tree over n leaves. Leaf i is taken from
// get(i); ok==false means the leaf is missing. n is padded internally
// to a power of two with missing leaves.
func BuildTree(n int, get func(i int) (data []byte, ok bool)) *Tree {
	if n < 1 {
		n = 1
	}
	size := 1
	for size < n {
		size *= 2
	}
	leaves := make([][32]byte, size)
	for i := 0; i < size; i++ {
		if i < n {
			if data, ok := get(i); ok {
				if len(data) != BlockSize {
					panic("mirror: block has wrong length")
				}
				leaves[i] = leafHash(data)
				continue
			}
		}
		leaves[i] = missingLeafHash(i)
	}
	levels := [][][32]byte{leaves}
	cur := leaves
	for len(cur) > 1 {
		next := make([][32]byte, len(cur)/2)
		for i := range next {
			next[i] = nodeHash(cur[2*i], cur[2*i+1])
		}
		levels = append(levels, next)
		cur = next
	}
	return &Tree{levels: levels, nleaf: n}
}

// Root returns the root hash of the tree.
func (t *Tree) Root() [32]byte {
	return t.levels[len(t.levels)-1][0]
}

// NumLeaves returns the logical leaf count.
func (t *Tree) NumLeaves() int { return t.nleaf }

// Diff returns the sorted leaf indices that dst must repair in order to
// match src. Roots are compared first; only mismatching subtrees are
// descended into, so equal subtrees are never visited.
func Diff(dst, src *Tree) []int {
	if dst.nleaf != src.nleaf {
		panic("mirror: diff of trees with different leaf counts")
	}
	var out []int
	var walk func(d, s *Tree, level, lo int)
	walk = func(d, s *Tree, level, lo int) {
		if d.levels[level][lo] == s.levels[level][lo] {
			return
		}
		if level == 0 {
			if lo < d.nleaf {
				out = append(out, lo)
			}
			return
		}
		walk(d, s, level-1, 2*lo)
		walk(d, s, level-1, 2*lo+1)
	}
	walk(dst, src, len(dst.levels)-1, 0)
	return out
}
