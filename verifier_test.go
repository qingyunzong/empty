package sigverify

import (
	"errors"
	"testing"
	"time"
)

var epoch = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func at(minutes int) time.Time { return epoch.Add(time.Duration(minutes) * time.Minute) }

// env is a virtual-event harness: a key store, a verifier, and a fake
// adapter, all driven by an explicit virtual clock (no real sleeping).
type env struct {
	store    *KeyStore
	verifier *Verifier
	adapter  FakeAdapter
}

func newEnv() *env {
	store := NewKeyStore()
	e := &env{store: store, adapter: FakeAdapter{}}
	e.verifier = &Verifier{
		Store:        store,
		Adapter:      e.adapter,
		MaxAge:       10 * time.Minute,
		MaxClockSkew: 30 * time.Second,
	}
	return e
}

// sign builds a request signed by keyID at signedAt. It uses the
// registered key material when the key exists, and arbitrary material
// otherwise, so unknown-key requests carry a well-formed-looking
// signature and still must not verify.
func (e *env) sign(keyID string, payload []byte, signedAt time.Time) Request {
	material := []byte("unregistered-material")
	if k, ok := e.store.Lookup(keyID); ok {
		material = k.Material
	}
	return Request{
		KeyID:     keyID,
		Payload:   payload,
		Signature: e.adapter.Sign(material, payload),
		SignedAt:  signedAt,
	}
}

func TestHalfOpenValidityWindow(t *testing.T) {
	e := newEnv()
	if err := e.store.Add(Key{ID: "k1", Material: []byte("m1"), NotBefore: at(0), NotAfter: at(60)}); err != nil {
		t.Fatal(err)
	}
	payload := []byte("hello")

	cases := []struct {
		name      string
		signedAt  time.Time
		receiveAt time.Time
		wantErr   error
	}{
		{"before NotBefore", at(-1), at(-1), ErrKeyNotYetValid},
		{"exactly at NotBefore (inclusive)", at(0), at(0), nil},
		{"inside window", at(30), at(30), nil},
		{"exactly at NotAfter (exclusive)", at(60), at(60), ErrKeyExpired},
		{"after NotAfter", at(61), at(61), ErrKeyExpired},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := e.sign("k1", payload, tc.signedAt)
			err := e.verifier.Verify(req, tc.receiveAt)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("got %v, want %v", err, tc.wantErr)
			}
		})
	}
}

func TestBothSigningAndReceiveTimesChecked(t *testing.T) {
	e := newEnv()
	if err := e.store.Add(Key{ID: "k1", Material: []byte("m1"), NotBefore: at(0), NotAfter: at(60)}); err != nil {
		t.Fatal(err)
	}
	payload := []byte("data")

	// Signed inside the window but received after expiry: must fail.
	req := e.sign("k1", payload, at(55))
	if err := e.verifier.Verify(req, at(60)); !errors.Is(err, ErrKeyExpired) {
		t.Fatalf("receive after expiry: got %v, want %v", err, ErrKeyExpired)
	}

	// Received inside the window but signed before NotBefore: must fail.
	req = e.sign("k1", payload, at(-5))
	if err := e.verifier.Verify(req, at(1)); !errors.Is(err, ErrKeyNotYetValid) {
		t.Fatalf("signed before validity: got %v, want %v", err, ErrKeyNotYetValid)
	}

	// Both inside: must pass.
	req = e.sign("k1", payload, at(10))
	if err := e.verifier.Verify(req, at(12)); err != nil {
		t.Fatalf("both inside: got %v, want nil", err)
	}
}

// TestRotationWithExplicitOverlap scripts a virtual event timeline:
// k1 is active, k2 rotates in with a 10-minute overlap, k1 expires.
func TestRotationWithExplicitOverlap(t *testing.T) {
	e := newEnv()
	if err := e.store.Add(Key{ID: "k1", Material: []byte("m1"), NotBefore: at(0), NotAfter: at(60)}); err != nil {
		t.Fatal(err)
	}
	// Rotate: k2 becomes valid at at(50), overlapping k1 for 10 minutes.
	if err := e.store.Rotate("k1", Key{ID: "k2", Material: []byte("m2"), NotAfter: at(120)}, 10*time.Minute); err != nil {
		t.Fatal(err)
	}
	k2, _ := e.store.Lookup("k2")
	if !k2.NotBefore.Equal(at(50)) {
		t.Fatalf("k2.NotBefore = %v, want %v", k2.NotBefore, at(50))
	}

	payload := []byte("rotated")
	type event struct {
		atMinute int
		keyID    string
		wantErr  error
	}
	// Virtual timeline: sign and receive at the same virtual instant.
	timeline := []event{
		{49, "k1", nil}, // k1 valid before overlap
		{49, "k2", ErrKeyNotYetValid},
		{50, "k1", nil}, // overlap begins: both keys verify
		{50, "k2", nil},
		{59, "k1", nil},
		{59, "k2", nil},
		{60, "k1", ErrKeyExpired}, // k1 window ends (exclusive)
		{60, "k2", nil},
		{119, "k2", nil},
		{120, "k2", ErrKeyExpired},
	}
	for _, ev := range timeline {
		req := e.sign(ev.keyID, payload, at(ev.atMinute))
		err := e.verifier.Verify(req, at(ev.atMinute))
		if !errors.Is(err, ev.wantErr) {
			t.Errorf("t=%d key=%s: got %v, want %v", ev.atMinute, ev.keyID, err, ev.wantErr)
		}
	}
}

// TestRevocationTakesEffectImmediately verifies that once revoked, a key
// fails even for requests signed while it was still valid.
func TestRevocationTakesEffectImmediately(t *testing.T) {
	e := newEnv()
	if err := e.store.Add(Key{ID: "k1", Material: []byte("m1"), NotBefore: at(0), NotAfter: at(60)}); err != nil {
		t.Fatal(err)
	}
	payload := []byte("urgent")

	// Signed at t=29, received at t=29: valid.
	req := e.sign("k1", payload, at(29))
	if err := e.verifier.Verify(req, at(29)); err != nil {
		t.Fatalf("pre-revocation: got %v, want nil", err)
	}

	// Revoke at t=30.
	if err := e.store.Revoke("k1", at(30)); err != nil {
		t.Fatal(err)
	}

	// Same request (signed at t=29, before revocation) received at t=31:
	// the receive time is past revocation, so it must fail.
	if err := e.verifier.Verify(req, at(31)); !errors.Is(err, ErrKeyRevoked) {
		t.Fatalf("received after revocation: got %v, want %v", err, ErrKeyRevoked)
	}

	// Signed after revocation: must fail.
	req = e.sign("k1", payload, at(31))
	if err := e.verifier.Verify(req, at(31)); !errors.Is(err, ErrKeyRevoked) {
		t.Fatalf("signed after revocation: got %v, want %v", err, ErrKeyRevoked)
	}

	// Revoking an unknown key reports ErrUnknownKey.
	if err := e.store.Revoke("nope", at(31)); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("revoke unknown: got %v, want %v", err, ErrUnknownKey)
	}
}

// TestUnknownKeyNeverValid ensures requests carrying an unregistered key
// ID never verify, even with a well-formed-looking signature and a
// receive time inside some other key's window.
func TestUnknownKeyNeverValid(t *testing.T) {
	e := newEnv()
	if err := e.store.Add(Key{ID: "k1", Material: []byte("m1"), NotBefore: at(0), NotAfter: at(60)}); err != nil {
		t.Fatal(err)
	}
	payload := []byte("forged")

	// Unknown key ID, signature computed over arbitrary material.
	req := e.sign("ghost", payload, at(10))
	if err := e.verifier.Verify(req, at(10)); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("unknown key: got %v, want %v", err, ErrUnknownKey)
	}

	// Empty key ID is equally unknown.
	req = e.sign("", payload, at(10))
	if err := e.verifier.Verify(req, at(10)); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("empty key ID: got %v, want %v", err, ErrUnknownKey)
	}

	// Known key ID but wrong signature material (attacker's key): the
	// lookup succeeds yet the signature must fail, not pass.
	req = Request{
		KeyID:     "k1",
		Payload:   payload,
		Signature: e.adapter.Sign([]byte("attacker-material"), payload),
		SignedAt:  at(10),
	}
	if err := e.verifier.Verify(req, at(10)); !errors.Is(err, ErrSignatureInvalid) {
		t.Fatalf("wrong material: got %v, want %v", err, ErrSignatureInvalid)
	}
}

func TestFreshnessAndClockSkew(t *testing.T) {
	e := newEnv()
	if err := e.store.Add(Key{ID: "k1", Material: []byte("m1"), NotBefore: at(0), NotAfter: at(120)}); err != nil {
		t.Fatal(err)
	}
	payload := []byte("fresh")

	// Signed 11 minutes before receipt: exceeds MaxAge of 10 minutes.
	req := e.sign("k1", payload, at(0))
	if err := e.verifier.Verify(req, at(11)); !errors.Is(err, ErrRequestTooOld) {
		t.Fatalf("stale request: got %v, want %v", err, ErrRequestTooOld)
	}

	// Signed 40 seconds in the future: beyond the 30-second skew.
	req = e.sign("k1", payload, at(10).Add(40*time.Second))
	if err := e.verifier.Verify(req, at(10)); !errors.Is(err, ErrSignedInFuture) {
		t.Fatalf("future signature: got %v, want %v", err, ErrSignedInFuture)
	}

	// Signed 20 seconds in the future: within skew, accepted.
	req = e.sign("k1", payload, at(10).Add(20*time.Second))
	if err := e.verifier.Verify(req, at(10)); err != nil {
		t.Fatalf("within skew: got %v, want nil", err)
	}
}

func TestTamperedSignatureRejected(t *testing.T) {
	e := newEnv()
	if err := e.store.Add(Key{ID: "k1", Material: []byte("m1"), NotBefore: at(0), NotAfter: at(60)}); err != nil {
		t.Fatal(err)
	}
	req := e.sign("k1", []byte("original"), at(10))
	req.Payload = []byte("tampered")
	if err := e.verifier.Verify(req, at(10)); !errors.Is(err, ErrSignatureInvalid) {
		t.Fatalf("tampered payload: got %v, want %v", err, ErrSignatureInvalid)
	}
}

func TestStoreRejectsInvalidKeys(t *testing.T) {
	e := newEnv()
	if err := e.store.Add(Key{ID: "", Material: []byte("m"), NotBefore: at(0), NotAfter: at(1)}); err == nil {
		t.Fatal("empty ID accepted")
	}
	if err := e.store.Add(Key{ID: "bad", Material: []byte("m"), NotBefore: at(1), NotAfter: at(1)}); err == nil {
		t.Fatal("empty window accepted")
	}
	if err := e.store.Add(Key{ID: "k", Material: []byte("m"), NotBefore: at(0), NotAfter: at(1)}); err != nil {
		t.Fatal(err)
	}
	if err := e.store.Add(Key{ID: "k", Material: []byte("m"), NotBefore: at(0), NotAfter: at(1)}); err == nil {
		t.Fatal("duplicate ID accepted")
	}
	if err := e.store.Rotate("missing", Key{ID: "k2", NotAfter: at(2)}, time.Minute); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("rotate from unknown: got %v, want %v", err, ErrUnknownKey)
	}
}
