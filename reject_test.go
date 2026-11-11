package q216

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRejectsUnknownRole(t *testing.T) {
	fx, _, _ := newFixture(t)
	allKeys := append(append([]*testKey{}, fx.rootKey[:]...), fx.tgtKey[:]...)
	signed := rootSigned(2, fx.expires, allKeys, []roleSpec{
		{name: RoleRoot, keys: fx.rootKey[:], threshold: 2},
		{name: RoleTargets, keys: fx.tgtKey[:], threshold: 1},
		{name: "snapshot", keys: fx.tgtKey[:], threshold: 1},
	})
	raw := signEnvelope(t, signed, fx.rootKey[0], fx.rootKey[1])
	updater := NewUpdater(NewMemoryStore(), clockOf(fx))
	if _, err := updater.Bootstrap(context.Background(), raw); !errors.Is(err, ErrUnknownRole) {
		t.Fatalf("unknown role: expected ErrUnknownRole, got %v", err)
	}
}

func TestRejectsDuplicateKeyIDInRoot(t *testing.T) {
	fx, _, _ := newFixture(t)
	dup := fx.rootKey[0]
	signed := map[string]any{
		"type":    typeRoot,
		"version": int64(2),
		"expires": fx.expires,
		"keys": []any{
			map[string]any{
				"keyid":   dup.id,
				"keytype": KeyTypeEd25519,
				"keyval":  map[string]any{"public": dup.hexPub},
			},
			map[string]any{
				"keyid":   dup.id,
				"keytype": KeyTypeEd25519,
				"keyval":  map[string]any{"public": dup.hexPub},
			},
		},
		"roles": []any{
			map[string]any{"name": RoleRoot, "keyids": []any{dup.id}, "threshold": 1},
			map[string]any{"name": RoleTargets, "keyids": []any{dup.id}, "threshold": 1},
		},
	}
	raw := signEnvelope(t, signed, fx.rootKey[0])
	updater := NewUpdater(NewMemoryStore(), clockOf(fx))
	_, err := updater.Bootstrap(context.Background(), raw)
	if !errors.Is(err, ErrDuplicateKey) {
		t.Fatalf("duplicate keyid: expected ErrDuplicateKey, got %v", err)
	}
}

func TestRejectsDuplicateKeyIDInRoleList(t *testing.T) {
	fx, _, _ := newFixture(t)
	allKeys := append(append([]*testKey{}, fx.rootKey[:]...), fx.tgtKey[:]...)
	signed := rootSigned(2, fx.expires, allKeys, []roleSpec{
		{name: RoleRoot, keys: fx.rootKey[:], threshold: 2},
		{name: RoleTargets, keys: []*testKey{fx.tgtKey[0], fx.tgtKey[0]}, threshold: 1},
	})
	raw := signEnvelope(t, signed, fx.rootKey[0], fx.rootKey[1])
	updater := NewUpdater(NewMemoryStore(), clockOf(fx))
	_, err := updater.Bootstrap(context.Background(), raw)
	if !errors.Is(err, ErrDuplicateKey) {
		t.Fatalf("duplicate role keyid: expected ErrDuplicateKey, got %v", err)
	}
}

func TestRejectsDuplicateSignatureKey(t *testing.T) {
	fx, updater, _ := newFixture(t)
	canon, _ := canonicalJSON(map[string]any{"x": int64(1)})
	sig1 := ed25519SignHex(t, fx.tgtKey[0], canon)
	sig2 := ed25519SignHex(t, fx.tgtKey[0], canon)
	raw, err := json.Marshal(map[string]any{
		"signatures": []any{
			map[string]any{"keyid": fx.tgtKey[0].id, "sig": sig1},
			map[string]any{"keyid": fx.tgtKey[0].id, "sig": sig2},
		},
		"signed": map[string]any{"x": int64(1)},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = updater.UpdateManifest(context.Background(), raw)
	if !errors.Is(err, ErrDuplicateKey) {
		t.Fatalf("duplicate signature keyid: expected ErrDuplicateKey, got %v", err)
	}
}

func TestRejectsUnknownField(t *testing.T) {
	fx, updater, _ := newFixture(t)
	content := []byte("x")
	entry := fx.targetEntry("plugins/acme", content, 1)
	signed := manifestSigned(1, fx.expires, []map[string]any{entry})
	signed["custom"] = "not-allowed"
	raw := signEnvelope(t, signed, fx.tgtKey[0])
	_, err := updater.UpdateManifest(context.Background(), raw)
	if !errors.Is(err, ErrUnknownField) {
		t.Fatalf("unknown field: expected ErrUnknownField, got %v", err)
	}
}

func TestRejectsDuplicateJSONKey(t *testing.T) {
	fx, updater, _ := newFixture(t)
	content := []byte("x")
	entry := fx.targetEntry("plugins/acme", content, 1)
	signed := manifestSigned(1, fx.expires, []map[string]any{entry})
	envelope := signEnvelope(t, signed, fx.tgtKey[0])
	// Inject a duplicate key into the raw JSON.
	tampered := injectDuplicateKey(t, envelope)
	_, err := updater.UpdateManifest(context.Background(), tampered)
	if !errors.Is(err, ErrDuplicateKey) {
		t.Fatalf("duplicate JSON key: expected ErrDuplicateKey, got %v", err)
	}
}

func TestRejectsTamperedSignedPayload(t *testing.T) {
	fx, updater, _ := newFixture(t)
	content := []byte("x")
	entry := fx.targetEntry("plugins/acme", content, 1)
	raw := fx.manifest(t, 1, []map[string]any{entry})

	parsed, err := parseEnvelope(raw)
	if err != nil {
		t.Fatal(err)
	}
	parsed.signed["version"] = int64(99)
	tampered, err := json.Marshal(map[string]any{
		"signatures": parsed.sigs,
		"signed":     parsed.signed,
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = updater.UpdateManifest(context.Background(), tampered)
	if !errors.Is(err, ErrInvalidSignature) {
		t.Fatalf("tampered payload: expected ErrInvalidSignature, got %v", err)
	}
}

func TestFileStoreRoundTrip(t *testing.T) {
	fx, _, _ := newFixture(t)
	dir := t.TempDir()
	path := filepath.Join(dir, "state.json")
	store := NewFileStore(path)

	if _, err := store.Load(context.Background()); !errors.Is(err, ErrUninitialized) {
		t.Fatalf("missing file: expected ErrUninitialized, got %v", err)
	}

	updater := NewUpdater(store, clockOf(fx))
	if _, err := updater.Bootstrap(context.Background(), fx.rootRaw); err != nil {
		t.Fatalf("bootstrap with file store: %v", err)
	}

	content := []byte("persisted-plugin")
	raw := fx.manifest(t, 1, []map[string]any{fx.targetEntry("plugins/acme", content, 1)})
	if _, err := updater.UpdateManifest(context.Background(), raw); err != nil {
		t.Fatalf("manifest with file store: %v", err)
	}

	// A fresh updater over the same file sees the persisted root and version.
	reloaded := NewUpdater(NewFileStore(path), clockOf(fx))
	state, err := reloaded.State(context.Background())
	if err != nil {
		t.Fatalf("reload state: %v", err)
	}
	if state.RootVersion != 1 || state.ManifestVersion != 1 {
		t.Fatalf("reloaded state = root %d / manifest %d", state.RootVersion, state.ManifestVersion)
	}

	// The reloaded store still rejects the already-accepted manifest version.
	if _, err := reloaded.UpdateManifest(context.Background(), raw); !errors.Is(err, ErrVersionRollback) {
		t.Fatalf("post-reload rollback: expected ErrVersionRollback, got %v", err)
	}
}

func TestOperationsBeforeBootstrapFail(t *testing.T) {
	updater := NewUpdater(NewMemoryStore())
	if _, err := updater.UpdateRoot(context.Background(), []byte("{}")); !errors.Is(err, ErrUninitialized) {
		t.Fatalf("UpdateRoot before bootstrap: expected ErrUninitialized, got %v", err)
	}
	if _, err := updater.UpdateManifest(context.Background(), []byte("{}")); !errors.Is(err, ErrUninitialized) {
		t.Fatalf("UpdateManifest before bootstrap: expected ErrUninitialized, got %v", err)
	}
}

func TestExpiredTrustedRootBlocksAllOperations(t *testing.T) {
	fx, _, memStore := newFixture(t)

	// Advance the clock past the trusted root's expiry.
	later := fx.now.Add(31 * 24 * time.Hour)
	updater := NewUpdater(memStore, WithClock(func() time.Time { return later }))

	content := []byte("x")
	entry := fx.targetEntry("plugins/acme", content, 1)
	signed := manifestSigned(1, later.Add(time.Hour).Format(time.RFC3339), []map[string]any{entry})
	raw := signEnvelope(t, signed, fx.tgtKey[0])

	if _, err := updater.UpdateManifest(context.Background(), raw); !errors.Is(err, ErrExpired) {
		t.Fatalf("manifest under expired root: expected ErrExpired, got %v", err)
	}

	// Root rotation is also blocked once the old root has expired.
	var newKeys [3]*testKey
	for i := range newKeys {
		newKeys[i] = genKey(t)
	}
	allKeys := append(append([]*testKey{}, newKeys[:]...), fx.tgtKey[:]...)
	newRootSigned := rootSigned(2, later.Add(time.Hour).Format(time.RFC3339), allKeys, []roleSpec{
		{name: RoleRoot, keys: newKeys[:], threshold: 2},
		{name: RoleTargets, keys: fx.tgtKey[:], threshold: 1},
	})
	rotation := signEnvelope(t, newRootSigned, fx.rootKey[0], fx.rootKey[1], newKeys[0], newKeys[1])
	if _, err := updater.UpdateRoot(context.Background(), rotation); !errors.Is(err, ErrExpired) {
		t.Fatalf("rotation under expired root: expected ErrExpired, got %v", err)
	}

	state, _ := memStore.Load(context.Background())
	if state.RootVersion != 1 || state.ManifestVersion != 0 {
		t.Fatalf("state changed despite expired root: root %d manifest %d",
			state.RootVersion, state.ManifestVersion)
	}
}

func injectDuplicateKey(t *testing.T, raw []byte) []byte {
	t.Helper()
	// Replace the first occurrence of "expires": with a duplicate field by
	// prepending another expires key inside the signed object.
	s := string(raw)
	marker := `"signed":{`
	idx := strings.Index(s, marker)
	if idx < 0 {
		t.Fatal("test envelope missing signed object")
	}
	insertAt := idx + len(marker)
	dup := `"expires":"1999-01-01T00:00:00Z",`
	return []byte(s[:insertAt] + dup + s[insertAt:])
}
