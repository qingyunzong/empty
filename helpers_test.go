package q216

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"testing"
	"time"
)

type testKey struct {
	id     string
	hexPub string
	pub    ed25519.PublicKey
	priv   ed25519.PrivateKey
}

func genKey(t *testing.T) *testKey {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	hexPub := hex.EncodeToString(pub)
	id, err := ComputeKeyID(hexPub)
	if err != nil {
		t.Fatalf("compute key id: %v", err)
	}
	return &testKey{id: id, hexPub: hexPub, pub: pub, priv: priv}
}

type roleSpec struct {
	name      string
	keys      []*testKey
	threshold int
}

func rootSigned(version int64, expires string, allKeys []*testKey, roles []roleSpec) map[string]any {
	keyEntries := make([]any, 0, len(allKeys))
	for _, k := range allKeys {
		keyEntries = append(keyEntries, map[string]any{
			"keyid":   k.id,
			"keytype": KeyTypeEd25519,
			"keyval":  map[string]any{"public": k.hexPub},
		})
	}
	roleEntries := make([]any, 0, len(roles))
	for _, r := range roles {
		ids := make([]any, 0, len(r.keys))
		for _, k := range r.keys {
			ids = append(ids, k.id)
		}
		roleEntries = append(roleEntries, map[string]any{
			"name":      r.name,
			"keyids":    ids,
			"threshold": r.threshold,
		})
	}
	return map[string]any{
		"type":    typeRoot,
		"version": version,
		"expires": expires,
		"keys":    keyEntries,
		"roles":   roleEntries,
	}
}

func manifestSigned(version int64, expires string, targets []map[string]any) map[string]any {
	rawTargets := make([]any, 0, len(targets))
	for _, t := range targets {
		rawTargets = append(rawTargets, t)
	}
	return map[string]any{
		"type":    typeManifest,
		"version": version,
		"expires": expires,
		"targets": rawTargets,
	}
}

// signEnvelope canonicalizes the signed payload under RFC 8785, signs the
// canonical bytes with every signer and returns the marshaled envelope.
func signEnvelope(t *testing.T, signed map[string]any, signers ...*testKey) []byte {
	t.Helper()
	canon, err := canonicalJSON(signed)
	if err != nil {
		t.Fatalf("canonicalize signed payload: %v", err)
	}
	sigs := make([]any, 0, len(signers))
	for _, k := range signers {
		sig := ed25519.Sign(k.priv, canon)
		sigs = append(sigs, map[string]any{
			"keyid": k.id,
			"sig":   hex.EncodeToString(sig),
		})
	}
	envelope := map[string]any{
		"signatures": sigs,
		"signed":     signed,
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	return raw
}

// failSaveStore wraps a Store and can force Save failures.
type failSaveStore struct {
	inner    Store
	failSave bool
}

func clockOf(fx *fixture) Option {
	return WithClock(func() time.Time { return fx.now })
}

func ed25519SignHex(t *testing.T, k *testKey, message []byte) string {
	t.Helper()
	return hex.EncodeToString(ed25519.Sign(k.priv, message))
}

func (f *failSaveStore) Load(ctx context.Context) (*State, error) {
	return f.inner.Load(ctx)
}

func (f *failSaveStore) Save(ctx context.Context, state *State) error {
	if f.failSave {
		return ErrPersist
	}
	return f.inner.Save(ctx, state)
}
