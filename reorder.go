package backupverify

import "fmt"

// Reorder reconstructs the chain order of arbitrarily permuted packages by
// following parent links starting from the manifest digest. It fails when
// the chain is broken (no package continues from the head while unused
// packages remain) or forks (two packages claim the same parent).
func Reorder(manifestDigest string, pkgs []*Package) ([]*Package, error) {
	used := make([]bool, len(pkgs))
	ordered := make([]*Package, 0, len(pkgs))
	head := manifestDigest
	for len(ordered) < len(pkgs) {
		next := -1
		for i, p := range pkgs {
			if used[i] || p.Parent != head {
				continue
			}
			if next >= 0 {
				return nil, fmt.Errorf("fork: packages %s and %s share parent %s",
					pkgs[next].Digest(), p.Digest(), head)
			}
			next = i
		}
		if next < 0 {
			return nil, fmt.Errorf("broken chain: no package with parent %s (%d of %d packages unreachable)",
				head, len(pkgs)-len(ordered), len(pkgs))
		}
		used[next] = true
		ordered = append(ordered, pkgs[next])
		head = pkgs[next].Digest()
	}
	return ordered, nil
}

// CrossCheck runs the serial manifest interpreter twice: once on the
// packages as given, and once on the chain reconstructed by Reorder. It
// reports whether both runs agree. Agreement means either both succeed
// with the same final state digest, or both fail with the same reason at
// the same package digest.
func CrossCheck(m *Manifest, pkgs []*Package, chunks ChunkStore) (serial, reordered Result, agree bool, err error) {
	serial = Verify(m, pkgs, chunks)
	ordered, err := Reorder(m.Digest(), pkgs)
	if err != nil {
		// The input order is not a permutation of a single chain; the
		// serial result stands on its own.
		return serial, Result{}, false, err
	}
	reordered = Verify(m, ordered, chunks)
	return serial, reordered, sameOutcome(serial, reordered), nil
}

func sameOutcome(a, b Result) bool {
	if a.OK() != b.OK() {
		return false
	}
	if a.OK() {
		return a.StateDigest == b.StateDigest
	}
	return a.Edge.Reason == b.Edge.Reason && a.Edge.Package == b.Edge.Package
}
