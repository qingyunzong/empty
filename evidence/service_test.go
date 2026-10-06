package evidence

import (
	"testing"
	"time"
)

func waitFor(t *testing.T, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", msg)
}

// TestLateAsyncVerificationDoesNotOverwriteNewState: a slow verification of
// generation 1 completes after generation 2 was submitted and applied; the
// late result must be discarded.
func TestLateAsyncVerificationDoesNotOverwriteNewState(t *testing.T) {
	release := make(chan struct{})
	slowDigest := ""
	c := &ControlledAdapter{
		VerifyFn: func(signer string, payload, sig []byte) error {
			if string(payload) == slowDigest {
				<-release // simulate a very slow async verification
			}
			return nil
		},
	}
	svc := NewService(NewValidator(c, NewTrustStore()))

	score := 5
	mkInput := func(version int) Input {
		m := &Manifest{
			ID:           "ev-async",
			Version:      version,
			ProblemHash:  HashBytes("problem", []byte("p")),
			ArtifactHash: HashBytes("artifact", []byte("a")),
			Score:        &score,
		}
		return Input{
			ExpectedVersion:      version,
			ExpectedProblemHash:  m.ProblemHash,
			ExpectedArtifactHash: m.ArtifactHash,
			Manifest:             m,
			Receipt: &Receipt{
				ManifestID: m.ID, Version: m.Version, Digest: m.Digest(),
				Signer: "s", TrustVersion: 1, SignedAt: time.Now(),
			},
		}
	}

	in1 := mkInput(1)
	slowDigest = in1.Receipt.Digest
	gen1 := svc.Submit("ev-async", in1) // will block inside Verify

	in2 := mkInput(2)
	gen2 := svc.Submit("ev-async", in2) // supersedes gen1
	waitFor(t, func() bool {
		st, _ := svc.State("ev-async")
		return st.Generation == gen2 && st.Report.Status == StatusValid
	}, "generation 2 to be applied")

	close(release) // let the late gen-1 verification finish
	waitFor(t, func() bool {
		_, verify := c.Calls()
		return verify >= 2
	}, "late verification to complete")

	st, _ := svc.State("ev-async")
	if st.Generation != gen2 {
		t.Fatalf("generation = %d, want %d (late result overwrote state)", st.Generation, gen2)
	}
	if st.Receipt == nil || st.Receipt.Version != 2 {
		t.Fatalf("receipt = %+v, want version-2 receipt", st.Receipt)
	}
	_ = gen1
}

// TestStaleReceiptRejected: an old receipt delivered after a newer one must
// not overwrite the state.
func TestStaleReceiptRejected(t *testing.T) {
	svc := NewService(NewValidator(&ControlledAdapter{}, NewTrustStore()))
	newer := &Receipt{ManifestID: "e", Version: 2, Signer: "s", TrustVersion: 1, SignedAt: time.Now()}
	older := &Receipt{ManifestID: "e", Version: 1, Signer: "s", TrustVersion: 1, SignedAt: newer.SignedAt.Add(-time.Hour)}

	if err := svc.ApplyReceipt("e", older); err != nil {
		t.Fatalf("first receipt rejected: %v", err)
	}
	if err := svc.ApplyReceipt("e", newer); err != nil {
		t.Fatalf("newer receipt rejected: %v", err)
	}
	if err := svc.ApplyReceipt("e", older); err != ErrStaleReceipt {
		t.Fatalf("stale receipt err = %v, want ErrStaleReceipt", err)
	}
	st, _ := svc.State("e")
	if st.Receipt == nil || st.Receipt.Version != 2 {
		t.Fatalf("receipt = %+v, want version-2 receipt retained", st.Receipt)
	}
}
