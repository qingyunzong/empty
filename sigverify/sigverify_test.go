package sigverify

import (
	"errors"
	"testing"
	"time"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func at(hours int) time.Time { return t0.Add(time.Duration(hours) * time.Hour) }

// event is one step in a virtual timeline used to drive the verifier.
type event struct {
	name string
	run  func(t *testing.T, env *env)
}

type env struct {
	reg      *Registry
	verifier *Verifier
	signer   FakeSigner
}

func newEnv() *env {
	reg := NewRegistry()
	signer := FakeSigner{}
	return &env{reg: reg, verifier: NewVerifier(reg, signer), signer: signer}
}

func (e *env) addKey(id string, notBefore, notAfter int) {
	k := &Key{ID: id, Secret: []byte("secret-" + id), NotBefore: at(notBefore), NotAfter: at(notAfter)}
	if err := e.reg.Add(k); err != nil {
		panic(err)
	}
}

func (e *env) sign(id string, payload []byte) []byte {
	return e.signer.Sign([]byte("secret-"+id), payload)
}

func runTimeline(t *testing.T, events []event) {
	e := newEnv()
	for _, ev := range events {
		t.Run(ev.name, func(t *testing.T) { ev.run(t, e) })
	}
}

func expectVerify(t *testing.T, e *env, id string, payload, sig []byte, signedAt, receivedAt int, want error) {
	t.Helper()
	err := e.verifier.Verify(id, payload, sig, at(signedAt), at(receivedAt))
	if want == nil {
		if err != nil {
			t.Fatalf("Verify(%q) = %v, want nil", id, err)
		}
		return
	}
	if !errors.Is(err, want) {
		t.Fatalf("Verify(%q) = %v, want %v", id, err, want)
	}
}

func TestHalfOpenValidityWindow(t *testing.T) {
	e := newEnv()
	e.addKey("k1", 10, 20)
	payload := []byte("payload")
	sig := e.sign("k1", payload)

	// NotBefore is inclusive.
	expectVerify(t, e, "k1", payload, sig, 10, 10, nil)
	// Inside the window.
	expectVerify(t, e, "k1", payload, sig, 15, 19, nil)
	// NotAfter is exclusive: signing exactly at NotAfter fails.
	expectVerify(t, e, "k1", payload, sig, 20, 20, ErrOutsideValidity)
	// Before the window.
	expectVerify(t, e, "k1", payload, sig, 9, 10, ErrOutsideValidity)
	// Receipt after the window fails even if signing was inside it.
	expectVerify(t, e, "k1", payload, sig, 15, 20, ErrOutsideValidity)
	// Receipt before the window fails even if signing was inside it.
	expectVerify(t, e, "k1", payload, sig, 15, 5, ErrOutsideValidity)
}

func TestRotationWithExplicitOverlap(t *testing.T) {
	e := newEnv()
	// Old key valid [0, 20), new key valid [10, 30): explicit overlap [10, 20).
	e.addKey("old", 0, 20)
	e.addKey("new", 10, 30)
	payload := []byte("rotation")
	oldSig := e.sign("old", payload)
	newSig := e.sign("new", payload)

	// Before rotation only the old key works.
	expectVerify(t, e, "old", payload, oldSig, 5, 5, nil)
	expectVerify(t, e, "new", payload, newSig, 5, 5, ErrOutsideValidity)
	// During the overlap both keys verify.
	expectVerify(t, e, "old", payload, oldSig, 15, 15, nil)
	expectVerify(t, e, "new", payload, newSig, 15, 15, nil)
	// After the old window closes only the new key works.
	expectVerify(t, e, "old", payload, oldSig, 15, 25, ErrOutsideValidity)
	expectVerify(t, e, "new", payload, newSig, 25, 25, nil)
}

func TestRevocationInvalidatesImmediately(t *testing.T) {
	e := newEnv()
	e.addKey("k1", 0, 100)
	payload := []byte("revoke-me")
	sig := e.sign("k1", payload)

	expectVerify(t, e, "k1", payload, sig, 10, 10, nil)

	if err := e.reg.Revoke("k1", at(50)); err != nil {
		t.Fatalf("Revoke: %v", err)
	}
	// Any receipt at or after the revocation time fails, even though the
	// signature was made inside the validity window.
	expectVerify(t, e, "k1", payload, sig, 10, 50, ErrKeyRevoked)
	expectVerify(t, e, "k1", payload, sig, 10, 60, ErrKeyRevoked)
	// Receipt before the revocation time still verifies.
	expectVerify(t, e, "k1", payload, sig, 10, 49, nil)
}

func TestUnknownKeyIsNeverValid(t *testing.T) {
	e := newEnv()
	e.addKey("known", 0, 100)
	payload := []byte("ghost")
	// Even a "signature" produced with the same adapter must not validate
	// under an unknown key ID.
	sig := e.signer.Sign([]byte("secret-unknown"), payload)

	expectVerify(t, e, "unknown", payload, sig, 10, 10, ErrUnknownKey)
	expectVerify(t, e, "", payload, sig, 10, 10, ErrUnknownKey)
	// Revoking an unknown key is an error, not a silent success.
	if err := e.reg.Revoke("unknown", at(0)); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("Revoke(unknown) = %v, want ErrUnknownKey", err)
	}
}

func TestBadSignature(t *testing.T) {
	e := newEnv()
	e.addKey("k1", 0, 100)
	payload := []byte("authentic")
	// Signature over a different payload must not verify.
	sig := e.sign("k1", []byte("tampered"))
	expectVerify(t, e, "k1", payload, sig, 10, 10, ErrBadSignature)
	// Signature from a different key's secret must not verify.
	sig = e.signer.Sign([]byte("secret-other"), payload)
	expectVerify(t, e, "k1", payload, sig, 10, 10, ErrBadSignature)
}

// TestVirtualEventTimeline drives the verifier through a scripted sequence of
// registration, rotation, traffic, and revocation events.
func TestVirtualEventTimeline(t *testing.T) {
	payload := []byte("event-payload")
	runTimeline(t, []event{
		{"register v1 [0,20)", func(t *testing.T, e *env) {
			e.addKey("svc", 0, 20)
			expectVerify(t, e, "svc", payload, e.sign("svc", payload), 5, 5, nil)
		}},
		{"rotate v2 [10,30) overlapping", func(t *testing.T, e *env) {
			// Rotate by adding a second version whose window overlaps v1.
			if err := e.reg.Add(&Key{ID: "svc", Secret: []byte("secret-svc-v2"), NotBefore: at(10), NotAfter: at(30)}); err != nil {
				t.Fatal(err)
			}
			expectVerify(t, e, "svc", payload, e.sign("svc", payload), 15, 15, nil)
			v2sig := e.signer.Sign([]byte("secret-svc-v2"), payload)
			expectVerify(t, e, "svc", payload, v2sig, 15, 15, nil)
		}},
		{"v1 expires, v2 serves traffic", func(t *testing.T, e *env) {
			expectVerify(t, e, "svc", payload, e.sign("svc", payload), 15, 25, ErrOutsideValidity)
			v2sig := e.signer.Sign([]byte("secret-svc-v2"), payload)
			expectVerify(t, e, "svc", payload, v2sig, 25, 25, nil)
		}},
		{"revoke all versions at t=26", func(t *testing.T, e *env) {
			if err := e.reg.Revoke("svc", at(26)); err != nil {
				t.Fatal(err)
			}
			v2sig := e.signer.Sign([]byte("secret-svc-v2"), payload)
			expectVerify(t, e, "svc", payload, v2sig, 20, 26, ErrKeyRevoked)
		}},
		{"unknown key never valid", func(t *testing.T, e *env) {
			expectVerify(t, e, "svc-v3", payload, e.sign("svc-v3", payload), 27, 27, ErrUnknownKey)
		}},
	})
}

func TestAddRejectsInvalidWindow(t *testing.T) {
	reg := NewRegistry()
	if err := reg.Add(&Key{ID: "bad", NotBefore: at(10), NotAfter: at(10)}); err == nil {
		t.Fatal("Add with empty window: got nil error")
	}
	if err := reg.Add(&Key{ID: "", NotBefore: at(0), NotAfter: at(1)}); err == nil {
		t.Fatal("Add with empty ID: got nil error")
	}
}
