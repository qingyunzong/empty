package formal

import "fmt"

// buildToken makes certificates unexported and coordinator-specific.
type buildToken struct {
	id uint64
}

// Certificate is proof that the index covers every commit in
// (Snapshot, Barrier]. It is issued only by Seal.
//
// A Certificate cannot be forged: it carries an unexported identity token and
// Publish rejects certificates from another coordinator or another build.
type Certificate struct {
	snapshot  Seq
	barrier   Seq
	commits   int
	mutations int
	digest    [32]byte
	verified  bool
	token     *buildToken
}

// Snapshot returns the watermark of the snapshot that seeded the index.
func (c Certificate) Snapshot() Seq { return c.snapshot }

// Barrier returns the commit sequence through which the log was drained.
func (c Certificate) Barrier() Seq { return c.barrier }

// Commits returns the number of commit records applied after the snapshot.
func (c Certificate) Commits() int { return c.commits }

// Mutations returns the number of key mutations applied after the snapshot.
func (c Certificate) Mutations() int { return c.mutations }

// Digest is a deterministic digest of the replayed commits. Two builds that
// cover identical commit records produce identical digests.
func (c Certificate) Digest() [32]byte { return c.digest }

// Verified reports whether a full table-vs-index audit ran before the
// certificate was issued.
func (c Certificate) Verified() bool { return c.verified }

// Valid reports whether the certificate was issued by a coordinator.
func (c Certificate) Valid() bool { return c.token != nil }

// String renders the public fields of a certificate.
func (c Certificate) String() string {
	return fmt.Sprintf("certificate{snapshot=%d barrier=%d commits=%d mutations=%d verified=%t}",
		c.snapshot, c.barrier, c.commits, c.mutations, c.verified)
}

// Watermark reports the three boundaries that make the handoff explicit.
type Watermark struct {
	// Snapshot is the commit sequence of the initial table scan.
	Snapshot Seq
	// Applied is the highest commit sequence actually applied.
	Applied Seq
	// Drained is the highest sequence for which the log has been proven
	// exhausted. Snapshot plus (Snapshot, Drained] is fully reflected in the
	// index.
	Drained Seq
	// Sealed is the barrier of the current certificate, or 0 before Seal.
	Sealed Seq
}

// Progress is returned by CatchUp and Seal.
type Progress struct {
	Watermark
	Commits   int
	Mutations int
}
