package q214

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

const baseTime = 1000

func newTestKeySet(t *testing.T) *KeySet {
	t.Helper()
	ks, err := NewKeySet([]KeyVersion{{Kid: fixtureKID, Key: fixtureKey}})
	if err != nil {
		t.Fatalf("NewKeySet: %v", err)
	}
	return ks
}

func newTestVerifier(t *testing.T, revoker RevocationChecker) (*Verifier, *fakeClock) {
	t.Helper()
	clock := newFakeClock(time.Unix(baseTime, 0))
	v, err := NewVerifier(newTestKeySet(t), clock, fixtureAud, revoker)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	return v, clock
}

func hmacSig(signingInput string, key []byte) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(signingInput))
	return b64url(mac.Sum(nil))
}

func rawToken(headerJSON, payloadJSON []byte, signature string) string {
	return b64url(headerJSON) + "." + b64url(payloadJSON) + "." + signature
}

func verifyErr(v *Verifier, token string) error {
	_, err := v.Verify(token)
	return err
}

// TestTimeWindowBoundaries exercises the half-open interval nbf <= now < exp.
func TestTimeWindowBoundaries(t *testing.T) {
	v, clock := newTestVerifier(t, nil)
	token := validFixtureToken("jti-boundary", baseTime, baseTime+10)

	cases := []struct {
		name string
		now  int64
		want error
	}{
		{"at nbf is valid", baseTime, nil},
		{"inside window is valid", baseTime + 5, nil},
		{"one before nbf", baseTime - 1, ErrNotYetValid},
		{"at exp is expired", baseTime + 10, ErrExpired},
		{"after exp is expired", baseTime + 11, ErrExpired},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			clock.Set(time.Unix(tc.now, 0))
			err := verifyErr(v, token)
			if !errors.Is(err, tc.want) {
				t.Fatalf("now=%d err=%v, want %v", tc.now, err, tc.want)
			}
		})
	}
}

func TestBadSignature(t *testing.T) {
	v, _ := newTestVerifier(t, nil)
	token := validFixtureToken("jti-badsig", baseTime, baseTime+10)
	parts := tokenParts(token)

	t.Run("flipped signature byte", func(t *testing.T) {
		sig, err := base64.RawURLEncoding.DecodeString(parts[2])
		if err != nil {
			t.Fatal(err)
		}
		sig[0] ^= 0x01
		bad := parts[0] + "." + parts[1] + "." + b64url(sig)
		if err := verifyErr(v, bad); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err=%v, want ErrBadSignature", err)
		}
	})

	t.Run("signature from another key", func(t *testing.T) {
		other := make([]byte, len(fixtureKey))
		copy(other, fixtureKey)
		other[0] ^= 0xFF
		forged := parts[0] + "." + parts[1] + "." + hmacSig(parts[0]+"."+parts[1], other)
		if err := verifyErr(v, forged); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err=%v, want ErrBadSignature", err)
		}
	})

	t.Run("tampered payload invalidates signature", func(t *testing.T) {
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		if err != nil {
			t.Fatal(err)
		}
		payload = append(payload, ' ')
		bad := parts[0] + "." + b64url(payload) + "." + parts[2]
		if err := verifyErr(v, bad); !errors.Is(err, ErrBadSignature) {
			t.Fatalf("err=%v, want ErrBadSignature", err)
		}
	})

	t.Run("empty or wrong segment counts", func(t *testing.T) {
		for _, bad := range []string{
			"",
			"onlyone",
			"a.b",
			"a.b.c.d",
			"a..c",
			".b.c",
			parts[0] + "." + parts[1] + ".",
		} {
			if err := verifyErr(v, bad); !errors.Is(err, ErrMalformedToken) {
				t.Fatalf("token=%q err=%v, want ErrMalformedToken", bad, err)
			}
		}
	})
}

func TestNonCanonicalBase64(t *testing.T) {
	v, _ := newTestVerifier(t, nil)
	token := validFixtureToken("jti-encoding", baseTime, baseTime+10)
	parts := tokenParts(token)

	t.Run("padded header", func(t *testing.T) {
		padded := parts[0] + "="
		bad := padded + "." + parts[1] + "." + parts[2]
		if err := verifyErr(v, bad); !errors.Is(err, ErrNonCanonicalEncoding) {
			t.Fatalf("err=%v, want ErrNonCanonicalEncoding", err)
		}
	})

	t.Run("standard alphabet character", func(t *testing.T) {
		bad := "ab+c." + parts[1] + "." + parts[2]
		if err := verifyErr(v, bad); !errors.Is(err, ErrNonCanonicalEncoding) {
			t.Fatalf("err=%v, want ErrNonCanonicalEncoding", err)
		}
	})

	t.Run("non-minimal signature encoding", func(t *testing.T) {
		// No byte sequence encodes to a segment of length 1 mod 4, so such
		// a segment is intrinsically non-canonical and must be rejected
		// before any HMAC comparison.
		nonMinimal := "AAAAA" // length 5 == 1 mod 4: no canonical segment has it
		bad := parts[0] + "." + parts[1] + "." + nonMinimal
		if err := verifyErr(v, bad); !errors.Is(err, ErrNonCanonicalEncoding) {
			t.Fatalf("err=%v, want ErrNonCanonicalEncoding", err)
		}
	})
}

func TestStrictJSON(t *testing.T) {
	v, _ := newTestVerifier(t, nil)
	header := fixtureHeader(fixtureKID)

	t.Run("duplicate header key", func(t *testing.T) {
		dup := []byte(`{"alg":"HS256","alg":"HS256","kid":"kid-v1"}`)
		token := rawToken(dup, fixturePayload("j", baseTime, baseTime+10),
			hmacSig(b64url(dup)+".", fixtureKey))
		if err := verifyErr(v, token); !errors.Is(err, ErrMalformedJSON) {
			t.Fatalf("err=%v, want ErrMalformedJSON", err)
		}
	})

	t.Run("duplicate payload key", func(t *testing.T) {
		dup := []byte(`{"aud":"svc://billing","exp":1010,"nbf":1000,"jti":"j","jti":"k"}`)
		token := signFixtureToken(fixtureKID, fixtureKey, header, dup)
		if err := verifyErr(v, token); !errors.Is(err, ErrMalformedJSON) {
			t.Fatalf("err=%v, want ErrMalformedJSON", err)
		}
	})

	t.Run("duplicate key inside nested payload object", func(t *testing.T) {
		dup := []byte(`{"aud":"svc://billing","exp":1010,"nbf":1000,"jti":"j","meta":{"a":1,"a":2}}`)
		token := signFixtureToken(fixtureKID, fixtureKey, header, dup)
		if err := verifyErr(v, token); !errors.Is(err, ErrMalformedJSON) {
			t.Fatalf("err=%v, want ErrMalformedJSON", err)
		}
	})

	t.Run("unknown header field", func(t *testing.T) {
		extra := []byte(`{"alg":"HS256","kid":"kid-v1","cty":"JWT"}`)
		token := signFixtureToken(fixtureKID, fixtureKey, extra,
			fixturePayload("j", baseTime, baseTime+10))
		if err := verifyErr(v, token); !errors.Is(err, ErrMalformedJSON) {
			t.Fatalf("err=%v, want ErrMalformedJSON", err)
		}
	})

	t.Run("unknown payload field", func(t *testing.T) {
		extra := []byte(`{"aud":"svc://billing","exp":1010,"nbf":1000,"jti":"j","iss":"x"}`)
		token := signFixtureToken(fixtureKID, fixtureKey, header, extra)
		if err := verifyErr(v, token); !errors.Is(err, ErrMalformedJSON) {
			t.Fatalf("err=%v, want ErrMalformedJSON", err)
		}
	})

	t.Run("trailing second json value", func(t *testing.T) {
		token := rawToken(append(append([]byte{}, header...), []byte(` {}`)...),
			fixturePayload("j", baseTime, baseTime+10), "")
		if err := verifyErr(v, token); err == nil {
			t.Fatal("expected error for trailing JSON value")
		}
	})

	t.Run("root non-object header", func(t *testing.T) {
		token := signFixtureToken(fixtureKID, fixtureKey,
			[]byte(`["HS256"]`), fixturePayload("j", baseTime, baseTime+10))
		if err := verifyErr(v, token); !errors.Is(err, ErrMalformedJSON) {
			t.Fatalf("err=%v, want ErrMalformedJSON", err)
		}
	})
}

func TestAlgorithmSubstitution(t *testing.T) {
	v, _ := newTestVerifier(t, nil)

	for _, alg := range []string{"none", "NONE", "HS384", "HS512", "RS256", "ES256", "hs256"} {
		t.Run("alg="+alg, func(t *testing.T) {
			headerJSON, _ := json.Marshal(map[string]string{"alg": alg, "kid": fixtureKID})
			token := signFixtureToken(fixtureKID, fixtureKey,
				headerJSON, fixturePayload("j", baseTime, baseTime+10))
			if err := verifyErr(v, token); !errors.Is(err, ErrUnsupportedAlgorithm) {
				t.Fatalf("err=%v, want ErrUnsupportedAlgorithm", err)
			}
		})
	}

	t.Run("non-string alg type", func(t *testing.T) {
		headerJSON := []byte(`{"alg":256,"kid":"kid-v1"}`)
		token := signFixtureToken(fixtureKID, fixtureKey,
			headerJSON, fixturePayload("j", baseTime, baseTime+10))
		if err := verifyErr(v, token); !errors.Is(err, ErrMalformedJSON) {
			t.Fatalf("err=%v, want ErrMalformedJSON", err)
		}
	})

	t.Run("missing alg", func(t *testing.T) {
		headerJSON := []byte(`{"kid":"kid-v1"}`)
		token := signFixtureToken(fixtureKID, fixtureKey,
			headerJSON, fixturePayload("j", baseTime, baseTime+10))
		if err := verifyErr(v, token); !errors.Is(err, ErrBadHeader) {
			t.Fatalf("err=%v, want ErrBadHeader", err)
		}
	})

	t.Run("missing kid", func(t *testing.T) {
		headerJSON := []byte(`{"alg":"HS256"}`)
		token := signFixtureToken(fixtureKID, fixtureKey,
			headerJSON, fixturePayload("j", baseTime, baseTime+10))
		if err := verifyErr(v, token); !errors.Is(err, ErrBadHeader) {
			t.Fatalf("err=%v, want ErrBadHeader", err)
		}
	})
}

func TestClaimValidation(t *testing.T) {
	v, _ := newTestVerifier(t, nil)
	header := fixtureHeader(fixtureKID)

	validPayload := func() map[string]any {
		return map[string]any{
			"aud": fixtureAud,
			"exp": int64(baseTime + 10),
			"nbf": int64(baseTime),
			"jti": "jti-claims",
		}
	}

	t.Run("each required claim missing", func(t *testing.T) {
		for _, key := range []string{"aud", "exp", "nbf", "jti"} {
			payloadMap := validPayload()
			delete(payloadMap, key)
			data, _ := json.Marshal(payloadMap)
			token := signFixtureToken(fixtureKID, fixtureKey, header, data)
			if err := verifyErr(v, token); !errors.Is(err, ErrMissingClaim) {
				t.Fatalf("missing %s: err=%v, want ErrMissingClaim", key, err)
			}
		}
	})

	t.Run("wrong claim types", func(t *testing.T) {
		badPayloads := map[string][]byte{
			"aud array":  []byte(`{"aud":["svc://billing"],"exp":1010,"nbf":1000,"jti":"j"}`),
			"exp string": []byte(`{"aud":"svc://billing","exp":"1010","nbf":1000,"jti":"j"}`),
			"nbf float":  []byte(`{"aud":"svc://billing","exp":1010,"nbf":1000.5,"jti":"j"}`),
			"jti number": []byte(`{"aud":"svc://billing","exp":1010,"nbf":1000,"jti":42}`),
			"exp bool":   []byte(`{"aud":"svc://billing","exp":true,"nbf":1000,"jti":"j"}`),
		}
		for name, payload := range badPayloads {
			t.Run(name, func(t *testing.T) {
				token := signFixtureToken(fixtureKID, fixtureKey, header, payload)
				err := verifyErr(v, token)
				if !errors.Is(err, ErrBadClaim) && !errors.Is(err, ErrMalformedJSON) {
					t.Fatalf("err=%v, want ErrBadClaim or ErrMalformedJSON", err)
				}
			})
		}
	})

	t.Run("explicit null claim treated as missing", func(t *testing.T) {
		payload := []byte(`{"aud":"svc://billing","exp":null,"nbf":1000,"jti":"j"}`)
		token := signFixtureToken(fixtureKID, fixtureKey, header, payload)
		if err := verifyErr(v, token); !errors.Is(err, ErrMissingClaim) {
			t.Fatalf("err=%v, want ErrMissingClaim", err)
		}
	})

	t.Run("empty string claims", func(t *testing.T) {
		for _, payload := range [][]byte{
			[]byte(`{"aud":"","exp":1010,"nbf":1000,"jti":"j"}`),
			[]byte(`{"aud":"svc://billing","exp":1010,"nbf":1000,"jti":""}`),
		} {
			token := signFixtureToken(fixtureKID, fixtureKey, header, payload)
			if err := verifyErr(v, token); !errors.Is(err, ErrBadClaim) {
				t.Fatalf("err=%v, want ErrBadClaim", err)
			}
		}
	})

	t.Run("audience mismatch", func(t *testing.T) {
		payload, _ := json.Marshal(map[string]any{
			"aud": "svc://other", "exp": baseTime + 10, "nbf": baseTime, "jti": "j",
		})
		token := signFixtureToken(fixtureKID, fixtureKey, header, payload)
		if err := verifyErr(v, token); !errors.Is(err, ErrAudience) {
			t.Fatalf("err=%v, want ErrAudience", err)
		}
	})

	t.Run("valid token returns claims", func(t *testing.T) {
		token := validFixtureToken("jti-happy", baseTime, baseTime+10)
		claims, err := v.Verify(token)
		if err != nil {
			t.Fatalf("Verify: %v", err)
		}
		if claims.JTI != "jti-happy" || claims.Audience != fixtureAud ||
			claims.NotBefore != baseTime || claims.Expiry != baseTime+10 {
			t.Fatalf("unexpected claims: %+v", claims)
		}
	})
}

func TestRevocationPriority(t *testing.T) {
	revoker := newMapRevoker("jti-dead")
	v, clock := newTestVerifier(t, revoker)

	t.Run("revoked valid token is rejected with ErrRevoked", func(t *testing.T) {
		token := validFixtureToken("jti-dead", baseTime, baseTime+10)
		if err := verifyErr(v, token); !errors.Is(err, ErrRevoked) {
			t.Fatalf("err=%v, want ErrRevoked", err)
		}
	})

	t.Run("revocation beats bad signature", func(t *testing.T) {
		parts := tokenParts(validFixtureToken("jti-dead", baseTime, baseTime+10))
		other := make([]byte, len(fixtureKey))
		copy(other, fixtureKey)
		other[0] ^= 0xFF
		forged := parts[0] + "." + parts[1] + "." + hmacSig(parts[0]+"."+parts[1], other)
		if err := verifyErr(v, forged); !errors.Is(err, ErrRevoked) {
			t.Fatalf("err=%v, want ErrRevoked before ErrBadSignature", err)
		}
	})

	t.Run("revocation beats expired window", func(t *testing.T) {
		token := validFixtureToken("jti-dead", baseTime, baseTime+10)
		clock.Set(time.Unix(baseTime+99, 0))
		if err := verifyErr(v, token); !errors.Is(err, ErrRevoked) {
			t.Fatalf("err=%v, want ErrRevoked before ErrExpired", err)
		}
	})

	t.Run("revocation beats future window", func(t *testing.T) {
		token := validFixtureToken("jti-dead", baseTime+50, baseTime+60)
		clock.Set(time.Unix(baseTime, 0))
		if err := verifyErr(v, token); !errors.Is(err, ErrRevoked) {
			t.Fatalf("err=%v, want ErrRevoked before ErrNotYetValid", err)
		}
	})

	t.Run("unrevoked jti still verifies", func(t *testing.T) {
		token := validFixtureToken("jti-alive", baseTime, baseTime+10)
		if _, err := v.Verify(token); err != nil {
			t.Fatalf("Verify: %v", err)
		}
	})

	t.Run("no revoker configured does not fail closed", func(t *testing.T) {
		v2, _ := newTestVerifier(t, nil)
		token := validFixtureToken("jti-dead", baseTime, baseTime+10)
		if _, err := v2.Verify(token); err != nil {
			t.Fatalf("Verify: %v", err)
		}
	})

	t.Run("revoked alg-none token is rejected", func(t *testing.T) {
		headerJSON, _ := json.Marshal(map[string]string{"alg": "none", "kid": fixtureKID})
		token := signFixtureToken(fixtureKID, fixtureKey, headerJSON,
			fixturePayload("jti-dead", baseTime, baseTime+10))
		err := verifyErr(v, token)
		if !errors.Is(err, ErrRevoked) && !errors.Is(err, ErrUnsupportedAlgorithm) {
			t.Fatalf("err=%v, want ErrRevoked or ErrUnsupportedAlgorithm", err)
		}
	})
}

func TestCallbackIsolation(t *testing.T) {
	revoker := newMapRevoker("jti-dead")
	v, _ := newTestVerifier(t, revoker)

	invalidTokens := map[string]string{
		"bad signature": mustTamper(t, validFixtureToken("jti-cb", baseTime, baseTime+10)),
		"revoked":       validFixtureToken("jti-dead", baseTime, baseTime+10),
		"malformed":     "a.b",
		"unknown kid": func() string {
			return signFixtureToken("kid-missing", fixtureKey,
				fixtureHeader("kid-missing"), fixturePayload("j", baseTime, baseTime+10))
		}(),
	}

	for name, token := range invalidTokens {
		t.Run(name, func(t *testing.T) {
			called := false
			err := v.VerifyCallback(token, func(*Claims) { called = true })
			if err == nil {
				t.Fatal("expected verification error")
			}
			if called {
				t.Fatal("business callback must not run for invalid token")
			}
		})
	}

	t.Run("callback receives claims for valid token", func(t *testing.T) {
		token := validFixtureToken("jti-good", baseTime, baseTime+10)
		var got *Claims
		if err := v.VerifyCallback(token, func(c *Claims) { got = c }); err != nil {
			t.Fatalf("VerifyCallback: %v", err)
		}
		if got == nil || got.JTI != "jti-good" {
			t.Fatalf("unexpected callback claims: %+v", got)
		}
	})
}

func mustTamper(t *testing.T, token string) string {
	t.Helper()
	parts := tokenParts(token)
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	sig[0] ^= 0x01
	return parts[0] + "." + parts[1] + "." + b64url(sig)
}

func TestKeySetValidation(t *testing.T) {
	t.Run("empty set rejected", func(t *testing.T) {
		if _, err := NewKeySet(nil); err == nil {
			t.Fatal("expected error for empty key set")
		}
	})

	t.Run("short key rejected", func(t *testing.T) {
		_, err := NewKeySet([]KeyVersion{{Kid: "k", Key: []byte("too-short")}})
		if err == nil {
			t.Fatal("expected error for short key")
		}
	})

	t.Run("duplicate kid rejected", func(t *testing.T) {
		_, err := NewKeySet([]KeyVersion{
			{Kid: "k", Key: fixtureKey},
			{Kid: "k", Key: fixtureKey},
		})
		if err == nil {
			t.Fatal("expected error for duplicate kid")
		}
	})

	t.Run("replace with invalid set keeps old version", func(t *testing.T) {
		ks := newTestKeySet(t)
		if err := ks.Replace(nil); err == nil {
			t.Fatal("expected Replace to fail")
		}
		snap := ks.snapshot()
		if _, ok := snap.byKid[fixtureKID]; !ok {
			t.Fatal("old key version must remain after failed replace")
		}
	})

	t.Run("constructor argument validation", func(t *testing.T) {
		clock := newFakeClock(time.Unix(baseTime, 0))
		if _, err := NewVerifier(nil, clock, fixtureAud, nil); err == nil {
			t.Fatal("expected error for nil key set")
		}
		if _, err := NewVerifier(newTestKeySet(t), nil, fixtureAud, nil); err == nil {
			t.Fatal("expected error for nil clock")
		}
		if _, err := NewVerifier(newTestKeySet(t), clock, "", nil); err == nil {
			t.Fatal("expected error for empty audience")
		}
	})
}

func TestKeyRotation(t *testing.T) {
	key2 := make([]byte, 32)
	for i := range key2 {
		key2[i] = byte(i + 1)
	}

	t.Run("old key removed after rotation", func(t *testing.T) {
		ks := newTestKeySet(t)
		clock := newFakeClock(time.Unix(baseTime, 0))
		v, err := NewVerifier(ks, clock, fixtureAud, nil)
		if err != nil {
			t.Fatal(err)
		}

		oldToken := validFixtureToken("jti-old", baseTime, baseTime+10)
		if _, err := v.Verify(oldToken); err != nil {
			t.Fatalf("pre-rotation verify: %v", err)
		}

		if err := ks.Replace([]KeyVersion{{Kid: fixtureKID2, Key: key2}}); err != nil {
			t.Fatalf("Replace: %v", err)
		}

		if err := verifyErr(v, oldToken); !errors.Is(err, ErrUnknownKey) {
			t.Fatalf("err=%v, want ErrUnknownKey for removed kid", err)
		}

		newToken := signFixtureToken(fixtureKID2, key2,
			fixtureHeader(fixtureKID2), fixturePayload("jti-new", baseTime, baseTime+10))
		if _, err := v.Verify(newToken); err != nil {
			t.Fatalf("post-rotation verify: %v", err)
		}
	})

	t.Run("in-flight verification pins one snapshot", func(t *testing.T) {
		ks := newTestKeySet(t)

		start := make(chan struct{})
		var wg sync.WaitGroup
		wg.Add(2)

		go func() {
			defer wg.Done()
			<-start
			for range 200 {
				rotated := make([]byte, 32)
				for i := range rotated {
					rotated[i] = byte(i)
				}
				_ = ks.Replace([]KeyVersion{{Kid: fixtureKID, Key: rotated}})
				_ = ks.Replace([]KeyVersion{{Kid: fixtureKID, Key: fixtureKey}})
			}
		}()

		go func() {
			defer wg.Done()
			<-start
			token := validFixtureToken("jti-race", baseTime, baseTime+10)
			clock := newFakeClock(time.Unix(baseTime, 0))
			v, _ := NewVerifier(ks, clock, fixtureAud, nil)
			for range 500 {
				err := verifyErr(v, token)
				switch {
				case err == nil:
					// Observed the original snapshot; token verifies.
				case errors.Is(err, ErrBadSignature):
					// Observed a rotated snapshot; same kid, different secret.
				default:
					t.Errorf("unexpected error during rotation: %v", err)
					return
				}
			}
		}()

		close(start)
		wg.Wait()
	})

	t.Run("snapshot is immutable after publication", func(t *testing.T) {
		ks := newTestKeySet(t)
		snap := ks.snapshot()
		original := string(snap.byKid[fixtureKID])

		key2copy := make([]byte, 32)
		copy(key2copy, key2)
		if err := ks.Replace([]KeyVersion{{Kid: fixtureKID2, Key: key2copy}}); err != nil {
			t.Fatal(err)
		}

		if string(snap.byKid[fixtureKID]) != original {
			t.Fatal("captured snapshot mutated by rotation")
		}
		if _, ok := snap.byKid[fixtureKID2]; ok {
			t.Fatal("captured snapshot must not gain new keys")
		}
	})

	t.Run("caller mutating input key does not corrupt stored secret", func(t *testing.T) {
		secret := make([]byte, 32)
		copy(secret, fixtureKey[:32])
		ks, err := NewKeySet([]KeyVersion{{Kid: "k", Key: secret}})
		if err != nil {
			t.Fatal(err)
		}
		for i := range secret {
			secret[i] = 0
		}
		if string(ks.snapshot().byKid["k"]) == string(secret) {
			t.Fatal("key set retained a mutable caller slice")
		}
	})
}
