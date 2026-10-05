package merklefs

// This file contains the independent proof verifier. It depends only on the
// public manifest specification (canonical entry encoding and the Merkle
// domain-separation constants) and re-derives everything else from the proof
// itself, so a faulty or malicious prover cannot smuggle in precomputed
// intermediate values.

import "crypto/sha256"

// VerifyProof independently verifies that entry is included at position
// proof.Index of a manifest of proof.Size entries whose Merkle root is root.
//
// The verifier recomputes the leaf hash from the entry's canonical record,
// replays the sibling steps bottom-up, and checks the result against root.
// It also validates the proof's structural consistency: the number of steps
// must match the tree shape implied by Index and Size, including odd-node
// promotions.
func VerifyProof(root [32]byte, entry *Entry, proof Proof) bool {
	if proof.Index < 0 || proof.Size <= 0 || proof.Index >= proof.Size {
		return false
	}
	if _, err := Canonicalize(entry.Path); err != nil {
		return false
	}

	// Recompute the leaf from the entry itself.
	h := sha256.New()
	h.Write([]byte{prefixLeaf})
	h.Write(encodeEntry(entry))
	var acc [32]byte
	copy(acc[:], h.Sum(nil))

	// Replay the path, deriving the expected sibling layout from Index/Size.
	idx := proof.Index
	width := proof.Size
	step := 0
	for width > 1 {
		if idx%2 == 0 && idx+1 < width {
			// Expect a right sibling.
			if step >= len(proof.Steps) || proof.Steps[step].Left {
				return false
			}
			acc = verifyNodeHash(acc, proof.Steps[step].Hash)
			step++
		} else if idx%2 == 1 {
			// Expect a left sibling.
			if step >= len(proof.Steps) || !proof.Steps[step].Left {
				return false
			}
			acc = verifyNodeHash(proof.Steps[step].Hash, acc)
			step++
		}
		// Odd rightmost node: promoted, consumes no step.
		idx /= 2
		width = (width + 1) / 2
	}
	if step != len(proof.Steps) {
		return false
	}
	return acc == root
}

// verifyNodeHash mirrors the node combiner from the specification:
// SHA-256(0x01 || left || right).
func verifyNodeHash(left, right [32]byte) [32]byte {
	h := sha256.New()
	h.Write([]byte{prefixNode})
	h.Write(left[:])
	h.Write(right[:])
	var sum [32]byte
	copy(sum[:], h.Sum(nil))
	return sum
}
