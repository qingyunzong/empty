package manifest

import (
	"crypto/sha256"
	"encoding/binary"
)

// ProofStep is one sibling hash along the path from leaf to root.
type ProofStep struct {
	Hash [32]byte
	Left bool // true when the sibling is the left child
}

// Proof is a Merkle inclusion proof for a single leaf.
type Proof struct {
	LeafIndex int
	TreeSize  int
	Steps     []ProofStep
}

func nodeHash(left, right [32]byte) [32]byte {
	h := sha256.New()
	h.Write([]byte{0x01}) // internal-node domain separator
	h.Write(left[:])
	h.Write(right[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

// RootOf computes the Merkle root of leaves. Levels with an odd node count
// promote the last node unchanged. The leaf count is mixed into the root so
// that the tree size is authenticated.
func RootOf(leaves [][32]byte) [32]byte {
	return sealRoot(uint64(len(leaves)), merkleRoot(leaves))
}

func merkleRoot(leaves [][32]byte) [32]byte {
	if len(leaves) == 0 {
		return sha256.Sum256(nil)
	}
	level := make([][32]byte, len(leaves))
	copy(level, leaves)
	for len(level) > 1 {
		level = nextLevel(level)
	}
	return level[0]
}

// sealRoot binds the tree size into the root commitment.
func sealRoot(size uint64, inner [32]byte) [32]byte {
	h := sha256.New()
	h.Write([]byte{0x02}) // root domain separator
	var buf [8]byte
	binary.BigEndian.PutUint64(buf[:], size)
	h.Write(buf[:])
	h.Write(inner[:])
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func nextLevel(level [][32]byte) [][32]byte {
	next := make([][32]byte, 0, (len(level)+1)/2)
	for i := 0; i+1 < len(level); i += 2 {
		next = append(next, nodeHash(level[i], level[i+1]))
	}
	if len(level)%2 == 1 {
		next = append(next, level[len(level)-1]) // promote odd node
	}
	return next
}

// NewProof builds an inclusion proof for leaves[index].
func NewProof(leaves [][32]byte, index int) Proof {
	p := Proof{LeafIndex: index, TreeSize: len(leaves)}
	level := make([][32]byte, len(leaves))
	copy(level, leaves)
	idx := index
	for len(level) > 1 {
		if !(idx == len(level)-1 && len(level)%2 == 1) {
			sib := idx ^ 1
			p.Steps = append(p.Steps, ProofStep{Hash: level[sib], Left: sib < idx})
		}
		idx /= 2
		level = nextLevel(level)
	}
	return p
}

// VerifyProof is the independent verifier: it recomputes the root from the
// leaf hash and the proof, requiring the level structure implied by
// TreeSize to match the supplied steps exactly.
func VerifyProof(root, leaf [32]byte, p Proof) bool {
	if p.TreeSize <= 0 || p.LeafIndex < 0 || p.LeafIndex >= p.TreeSize {
		return false
	}
	h := leaf
	idx := p.LeafIndex
	size := p.TreeSize
	step := 0
	for size > 1 {
		if idx == size-1 && size%2 == 1 {
			// promoted node: consumes no step
		} else {
			if step >= len(p.Steps) {
				return false
			}
			s := p.Steps[step]
			step++
			// The direction bit must agree with the index parity, binding
			// the proof to the claimed leaf position.
			if s.Left != (idx%2 == 1) {
				return false
			}
			if s.Left {
				h = nodeHash(s.Hash, h)
			} else {
				h = nodeHash(h, s.Hash)
			}
		}
		idx /= 2
		size = (size + 1) / 2
	}
	if step != len(p.Steps) {
		return false
	}
	return sealRoot(uint64(p.TreeSize), h) == root
}

// VerifyEntry verifies that entry is included in the tree committed to by
// root, hashing the entry independently via LeafHash.
func VerifyEntry(root [32]byte, e Entry, p Proof) bool {
	return VerifyProof(root, LeafHash(e), p)
}
