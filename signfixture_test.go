package q214

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"time"
)

// fixtureKey is a standalone test secret, never referenced by production code.
var fixtureKey = []byte("unit-fixture-secret-key-0123456789-abcdef!!")

const (
	fixtureKID  = "kid-v1"
	fixtureAud  = "svc://billing"
	fixtureKID2 = "kid-v2"
)

func b64url(data []byte) string {
	return base64.RawURLEncoding.EncodeToString(data)
}

// signFixtureToken builds a canonically encoded HS256 token with the given
// key. Header and payload are passed as marshaled JSON so tests can freely
// produce duplicate keys, wrong types or extra fields.
func signFixtureToken(kid string, key []byte, headerJSON, payloadJSON []byte) string {
	headerSeg := b64url(headerJSON)
	payloadSeg := b64url(payloadJSON)
	signingInput := headerSeg + "." + payloadSeg
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput))
	sig := b64url(mac.Sum(nil))
	return signingInput + "." + sig
}

func fixtureHeader(kid string) []byte {
	data, _ := json.Marshal(rawHeader{Alg: "HS256", Kid: kid})
	return data
}

// fixturePayload builds the canonical claim set for a validity window.
func fixturePayload(jti string, nbf, exp int64) []byte {
	data, _ := json.Marshal(map[string]any{
		"aud": fixtureAud,
		"exp": exp,
		"nbf": nbf,
		"jti": jti,
	})
	return data
}

func validFixtureToken(jti string, nbf, exp int64) string {
	return signFixtureToken(fixtureKID, fixtureKey,
		fixtureHeader(fixtureKID), fixturePayload(jti, nbf, exp))
}

// fakeClock is a goroutine-safe controllable Clock.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newFakeClock(t time.Time) *fakeClock { return &fakeClock{now: t} }

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = t
}

// mapRevoker is a goroutine-safe RevocationChecker backed by a set.
type mapRevoker struct {
	mu   sync.Mutex
	dead map[string]struct{}
}

func newMapRevoker(jtis ...string) *mapRevoker {
	r := &mapRevoker{dead: map[string]struct{}{}}
	for _, jti := range jtis {
		r.dead[jti] = struct{}{}
	}
	return r
}

func (r *mapRevoker) IsRevoked(jti string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.dead[jti]
	return ok
}

func (r *mapRevoker) Revoke(jti string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.dead[jti] = struct{}{}
}

// tokenParts exposes the three compact segments for tampering tests.
func tokenParts(token string) [3]string {
	var out [3]string
	copy(out[:], strings.Split(token, "."))
	return out
}
