package merklefs

import (
	"crypto/sha256"
	"encoding/binary"
)

// Domain separation prefixes, in the style of RFC 6962.
const (
	prefixLeaf = 0x00
	prefixNode = 0x01
)

// emptyRoot is the Merkle root of a manifest with no entries.
var emptyRoot = sha256.Sum256(nil)

// encodeEntry serializes an entry into its canonical binary record.
// This encoding is part of the manifest specification: the Merkle leaf for
// an entry is SHA-256(0x00 || record).
func encodeEntry(e *Entry) []byte {
	var buf []byte
	buf = append(buf, byte(e.Type))
	buf = appendUvarint(buf, uint64(len(e.Path)))
	buf = append(buf, e.Path...)
	switch e.Type {
	case TypeFile:
		var sz [8]byte
		binary.BigEndian.PutUint64(sz[:], uint64(e.Size))
		buf = append(buf, sz[:]...)
		buf = append(buf, e.Hash[:]...)
		buf = append(buf, e.ObjID[:]...)
	case TypeSymlink:
		buf = appendUvarint(buf, uint64(len(e.Target)))
		buf = append(buf, e.Target...)
	case TypeDir:
		// No payload.
	}
	return buf
}

func appendUvarint(buf []byte, v uint64) []byte {
	var tmp [binary.MaxVarintLen64]byte
	n := binary.PutUvarint(tmp[:], v)
	return append(buf, tmp[:n]...)
}

// leafHash computes the Merkle leaf hash of an entry.
func leafHash(e *Entry) [32]byte {
	h := sha256.New()
	h.Write([]byte{prefixLeaf})
	h.Write(encodeEntry(e))
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

// nodeHash computes the hash of an internal Merkle node.
func nodeHash(left, right [32]byte) [32]byte {
	h := sha256.New()
	h.Write([]byte{prefixNode})
	h.Write(left[:])
	h.Write(right[:])
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum
}

// computeRoot builds a balanced binary Merkle tree over the sorted entries
// and returns its root. At each level, adjacent pairs are combined; an odd
// trailing node is promoted unchanged to the next level.
func computeRoot(entries []Entry) [32]byte {
	if len(entries) == 0 {
		return emptyRoot
	}
	level := make([][32]byte, len(entries))
	for i := range entries {
		level[i] = leafHash(&entries[i])
	}
	return rootFromLeaves(level)
}

func rootFromLeaves(level [][32]byte) [32]byte {
	for len(level) > 1 {
		next := make([][32]byte, 0, (len(level)+1)/2)
		for i := 0; i+1 < len(level); i += 2 {
			next = append(next, nodeHash(level[i], level[i+1]))
		}
		if len(level)%2 == 1 {
			next = append(next, level[len(level)-1]) // promote odd node
		}
		level = next
	}
	return level[0]
}

// ProofStep is one sibling hash along a Merkle proof path.
type ProofStep struct {
	Hash [32]byte
	Left bool // true if this sibling is the left child of the parent
}

// Proof is a Merkle inclusion proof for one manifest entry.
type Proof struct {
	Index int         // index of the entry in the sorted manifest
	Size  int         // total number of entries (leaves) in the tree
	Steps []ProofStep // sibling hashes, bottom to top
}

// Prove generates an inclusion proof for the entry at index i.
func (m *Manifest) Prove(i int) (Proof, bool) {
	if i < 0 || i >= len(m.Entries) {
		return Proof{}, false
	}
	level := make([][32]byte, len(m.Entries))
	for j := range m.Entries {
		level[j] = leafHash(&m.Entries[j])
	}
	p := Proof{Index: i, Size: len(m.Entries)}
	idx := i
	for len(level) > 1 {
		var sib int
		var left bool
		if idx%2 == 0 {
			sib = idx + 1
			left = false // sibling is on the right
		} else {
			sib = idx - 1
			left = true
		}
		if sib < len(level) {
			p.Steps = append(p.Steps, ProofStep{Hash: level[sib], Left: left})
		}
		// else: odd node promoted, no sibling at this level.
		next := make([][32]byte, 0, (len(level)+1)/2)
		for k := 0; k+1 < len(level); k += 2 {
			next = append(next, nodeHash(level[k], level[k+1]))
		}
		if len(level)%2 == 1 {
			next = append(next, level[len(level)-1])
		}
		level = next
		idx /= 2
	}
	return p, true
}

// ProvePath generates an inclusion proof for the entry with the given
// canonical path.
func (m *Manifest) ProvePath(path string) (Entry, Proof, bool) {
	i, ok := entryIndex(m.Entries, path)
	if !ok {
		return Entry{}, Proof{}, false
	}
	p, _ := m.Prove(i)
	return m.Entries[i], p, true
}
