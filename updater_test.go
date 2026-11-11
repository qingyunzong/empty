package q216

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"
	"time"
)

type fixture struct {
	now     time.Time
	rootKey [3]*testKey
	tgtKey  [2]*testKey
	rootRaw []byte
	expires string
}

func newFixture(t *testing.T) (*fixture, *Updater, *MemoryStore) {
	t.Helper()
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	fx := &fixture{now: now}
	for i := range fx.rootKey {
		fx.rootKey[i] = genKey(t)
	}
	for i := range fx.tgtKey {
		fx.tgtKey[i] = genKey(t)
	}
	allKeys := append(append([]*testKey{}, fx.rootKey[:]...), fx.tgtKey[:]...)
	fx.expires = now.Add(30 * 24 * time.Hour).Format(time.RFC3339)
	signed := rootSigned(1, fx.expires, allKeys, []roleSpec{
		{name: RoleRoot, keys: fx.rootKey[:], threshold: 2},
		{name: RoleTargets, keys: fx.tgtKey[:], threshold: 1},
	})
	fx.rootRaw = signEnvelope(t, signed, fx.rootKey[0], fx.rootKey[1])

	store := NewMemoryStore()
	updater := NewUpdater(store, WithClock(func() time.Time { return fx.now }))
	if _, err := updater.Bootstrap(context.Background(), fx.rootRaw); err != nil {
		t.Fatalf("bootstrap: %v", err)
	}
	return fx, updater, store
}

func (f *fixture) targetEntry(name string, content []byte, version int64) map[string]any {
	sum := sha256.Sum256(content)
	return map[string]any{
		"name":    name,
		"length":  int64(len(content)),
		"hashes":  map[string]any{"sha256": hex.EncodeToString(sum[:])},
		"version": version,
	}
}

func (f *fixture) manifest(t *testing.T, version int64, targets []map[string]any, signers ...*testKey) []byte {
	t.Helper()
	if len(signers) == 0 {
		signers = []*testKey{f.tgtKey[0]}
	}
	return signEnvelope(t, manifestSigned(version, f.expires, targets), signers...)
}

func assertSentinel(t *testing.T, err error, target error) {
	t.Helper()
	if !errors.Is(err, target) {
		t.Fatalf("expected error wrapping %v, got %v", target, err)
	}
}

func TestBootstrapRequiresSelfSignatureThreshold(t *testing.T) {
	now := time.Date(2026, 11, 11, 12, 0, 0, 0, time.UTC)
	var rootKey [3]*testKey
	var tgtKey [2]*testKey
	for i := range rootKey {
		rootKey[i] = genKey(t)
	}
	for i := range tgtKey {
		tgtKey[i] = genKey(t)
	}
	allKeys := append(append([]*testKey{}, rootKey[:]...), tgtKey[:]...)
	expires := now.Add(time.Hour).Format(time.RFC3339)
	signed := rootSigned(1, expires, allKeys, []roleSpec{
		{name: RoleRoot, keys: rootKey[:], threshold: 2},
		{name: RoleTargets, keys: tgtKey[:], threshold: 1},
	})
	// Only one root signature where the threshold is two.
	raw := signEnvelope(t, signed, rootKey[0])
	updater := NewUpdater(NewMemoryStore(), WithClock(func() time.Time { return now }))
	_, err := updater.Bootstrap(context.Background(), raw)
	assertSentinel(t, err, ErrThresholdNotMet)
}

func TestRootRotationHappyPath(t *testing.T) {
	fx, updater, store := newFixture(t)

	var newKeys [3]*testKey
	for i := range newKeys {
		newKeys[i] = genKey(t)
	}
	allKeys := append(append([]*testKey{}, newKeys[:]...), fx.tgtKey[:]...)
	signed := rootSigned(2, fx.expires, allKeys, []roleSpec{
		{name: RoleRoot, keys: newKeys[:], threshold: 2},
		{name: RoleTargets, keys: fx.tgtKey[:], threshold: 1},
	})
	// Two old root keys authorize the rotation; two new root keys self-sign.
	raw := signEnvelope(t, signed, fx.rootKey[0], fx.rootKey[1], newKeys[0], newKeys[1])

	doc, err := updater.UpdateRoot(context.Background(), raw)
	if err != nil {
		t.Fatalf("root rotation: %v", err)
	}
	if doc.Version != 2 {
		t.Fatalf("expected root version 2, got %d", doc.Version)
	}
	state, _ := store.Load(context.Background())
	if state.RootVersion != 2 {
		t.Fatalf("persisted root version = %d, want 2", state.RootVersion)
	}

	// Re-presenting the same version is a rollback.
	_, err = updater.UpdateRoot(context.Background(), raw)
	assertSentinel(t, err, ErrVersionRollback)
}

func TestRootRotationOldRootUnderAuthorized(t *testing.T) {
	fx, updater, store := newFixture(t)

	var newKeys [3]*testKey
	for i := range newKeys {
		newKeys[i] = genKey(t)
	}
	allKeys := append(append([]*testKey{}, newKeys[:]...), fx.tgtKey[:]...)
	signed := rootSigned(2, fx.expires, allKeys, []roleSpec{
		{name: RoleRoot, keys: newKeys[:], threshold: 2},
		{name: RoleTargets, keys: fx.tgtKey[:], threshold: 1},
	})
	// Only ONE old root key signs while the old root threshold is two; the
	// new root self-signature is valid. Rotation must fail.
	raw := signEnvelope(t, signed, fx.rootKey[0], newKeys[0], newKeys[1])

	_, err := updater.UpdateRoot(context.Background(), raw)
	assertSentinel(t, err, ErrRootRotation)

	state, _ := store.Load(context.Background())
	if state.RootVersion != 1 {
		t.Fatalf("root version changed to %d after failed rotation", state.RootVersion)
	}
}

func TestExpiredAtExactExpiryInstant(t *testing.T) {
	fx, updater, store := newFixture(t)

	content := []byte("plugin-binary-1")
	entry := fx.targetEntry("plugins/acme", content, 1)
	// Expires exactly at the current clock time: must be treated as expired.
	signed := manifestSigned(1, fx.now.Format(time.RFC3339), []map[string]any{entry})
	raw := signEnvelope(t, signed, fx.tgtKey[0])

	_, err := updater.UpdateManifest(context.Background(), raw)
	assertSentinel(t, err, ErrExpired)

	state, _ := store.Load(context.Background())
	if state.ManifestVersion != 0 {
		t.Fatalf("manifest version advanced to %d on expired metadata", state.ManifestVersion)
	}

	// One nanosecond before expiry is still valid.
	validSigned := manifestSigned(1,
		fx.now.Add(time.Nanosecond).Format(time.RFC3339Nano), []map[string]any{entry})
	validRaw := signEnvelope(t, validSigned, fx.tgtKey[0])
	if _, err := updater.UpdateManifest(context.Background(), validRaw); err != nil {
		t.Fatalf("manifest one nanosecond before expiry rejected: %v", err)
	}
}

func TestManifestRollbackRejectedAndVersionPreserved(t *testing.T) {
	fx, updater, store := newFixture(t)

	content1 := []byte("plugin-binary-1")
	content2 := []byte("plugin-binary-22")
	raw1 := fx.manifest(t, 1, []map[string]any{fx.targetEntry("plugins/acme", content1, 1)})
	raw2 := fx.manifest(t, 2, []map[string]any{fx.targetEntry("plugins/acme", content2, 2)})

	if _, err := updater.UpdateManifest(context.Background(), raw1); err != nil {
		t.Fatalf("accept manifest v1: %v", err)
	}
	if _, err := updater.UpdateManifest(context.Background(), raw2); err != nil {
		t.Fatalf("accept manifest v2: %v", err)
	}
	state, _ := store.Load(context.Background())
	if state.ManifestVersion != 2 {
		t.Fatalf("expected accepted version 2, got %d", state.ManifestVersion)
	}

	// Re-presenting v1 and replaying v2 are both rollbacks.
	if _, err := updater.UpdateManifest(context.Background(), raw1); !errors.Is(err, ErrVersionRollback) {
		t.Fatalf("v1 rollback: expected ErrVersionRollback, got %v", err)
	}
	if _, err := updater.UpdateManifest(context.Background(), raw2); !errors.Is(err, ErrVersionRollback) {
		t.Fatalf("v2 replay: expected ErrVersionRollback, got %v", err)
	}

	state, _ = store.Load(context.Background())
	if state.ManifestVersion != 2 {
		t.Fatalf("accepted version lowered to %d after rollback attempts", state.ManifestVersion)
	}
}

func TestFailedUpdateDoesNotLowerAcceptedVersion(t *testing.T) {
	fx, updater, memStore := newFixture(t)

	content := []byte("plugin-binary-1")
	raw1 := fx.manifest(t, 1, []map[string]any{fx.targetEntry("plugins/acme", content, 1)})
	if _, err := updater.UpdateManifest(context.Background(), raw1); err != nil {
		t.Fatalf("accept manifest v1: %v", err)
	}

	// Inject a store whose Save fails; the accepted version must remain 1.
	failing := &failSaveStore{inner: memStore, failSave: true}
	failingUpdater := NewUpdater(failing, WithClock(func() time.Time { return fx.now }))
	raw3 := fx.manifest(t, 3, []map[string]any{fx.targetEntry("plugins/acme", content, 3)})
	if _, err := failingUpdater.UpdateManifest(context.Background(), raw3); !errors.Is(err, ErrPersist) {
		t.Fatalf("expected persistence error, got %v", err)
	}

	state, _ := memStore.Load(context.Background())
	if state.ManifestVersion != 1 {
		t.Fatalf("accepted version changed to %d after failed Save", state.ManifestVersion)
	}

	// An update signed by the wrong (root) key is also rejected without
	// mutating the accepted version.
	bad := fx.manifest(t, 4, []map[string]any{fx.targetEntry("plugins/acme", content, 4)}, fx.rootKey[0])
	if _, err := updater.UpdateManifest(context.Background(), bad); err == nil {
		t.Fatal("manifest signed by a root key must be rejected")
	}
	state, _ = memStore.Load(context.Background())
	if state.ManifestVersion != 1 {
		t.Fatalf("accepted version changed to %d after invalid update", state.ManifestVersion)
	}

	// Once the store recovers, the higher version is accepted normally.
	failing.failSave = false
	if _, err := failingUpdater.UpdateManifest(context.Background(), raw3); err != nil {
		t.Fatalf("retry manifest v3 after recovery: %v", err)
	}
	state, _ = memStore.Load(context.Background())
	if state.ManifestVersion != 3 {
		t.Fatalf("expected version 3 after recovery, got %d", state.ManifestVersion)
	}
}

func TestVerifyTargetLengthAndSHA256(t *testing.T) {
	fx, updater, _ := newFixture(t)

	content := []byte("the quick brown fox")
	entry := fx.targetEntry("plugins/acme", content, 1)
	raw := fx.manifest(t, 1, []map[string]any{entry})

	if err := updater.VerifyTarget(context.Background(), raw, "plugins/acme", bytes.NewReader(content)); err != nil {
		t.Fatalf("valid target rejected: %v", err)
	}

	// Truncated content fails the length check.
	if err := updater.VerifyTarget(context.Background(), raw, "plugins/acme",
		bytes.NewReader(content[:len(content)-3])); !errors.Is(err, ErrTargetMismatch) {
		t.Fatalf("truncated target: expected ErrTargetMismatch, got %v", err)
	}

	// Same length, different bytes fails the SHA-256 check.
	tampered := append([]byte(nil), content...)
	tampered[0]++
	if err := updater.VerifyTarget(context.Background(), raw, "plugins/acme",
		bytes.NewReader(tampered)); !errors.Is(err, ErrTargetMismatch) {
		t.Fatalf("tampered target: expected ErrTargetMismatch, got %v", err)
	}

	// Unknown target name.
	if err := updater.VerifyTarget(context.Background(), raw, "plugins/missing",
		bytes.NewReader(content)); !errors.Is(err, ErrTargetMismatch) {
		t.Fatalf("unknown target: expected ErrTargetMismatch, got %v", err)
	}
}

func TestRootRotationNewRootSelfSignatureInsufficient(t *testing.T) {
	fx, updater, store := newFixture(t)

	var newKeys [3]*testKey
	for i := range newKeys {
		newKeys[i] = genKey(t)
	}
	allKeys := append(append([]*testKey{}, newKeys[:]...), fx.tgtKey[:]...)
	signed := rootSigned(2, fx.expires, allKeys, []roleSpec{
		{name: RoleRoot, keys: newKeys[:], threshold: 2},
		{name: RoleTargets, keys: fx.tgtKey[:], threshold: 1},
	})
	// Old root threshold is met (two old keys) but the new root carries only
	// one self-signature while requiring two.
	raw := signEnvelope(t, signed, fx.rootKey[0], fx.rootKey[1], newKeys[0])

	_, err := updater.UpdateRoot(context.Background(), raw)
	assertSentinel(t, err, ErrRootRotation)

	state, _ := store.Load(context.Background())
	if state.RootVersion != 1 {
		t.Fatalf("root version changed to %d after failed rotation", state.RootVersion)
	}
}
