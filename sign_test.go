package canonenc

import (
	"bytes"
	"errors"
	"testing"
)

var testKey = []byte("test-signing-key-0123456789")

// TestSealOpenRoundTrip signs encoded payloads and opens them.
func TestSealOpenRoundTrip(t *testing.T) {
	payloads := [][]byte{allBytes(), []byte("hello"), {}, []byte("%0A\n")}
	for _, p := range payloads {
		enc, sig := Seal(testKey, p)
		if !Verify(testKey, enc, sig) {
			t.Fatalf("Verify failed for %x", p)
		}
		got, err := Open(testKey, enc, sig)
		if err != nil {
			t.Fatalf("Open: %v", err)
		}
		if !bytes.Equal(got, p) {
			t.Fatalf("Open round trip mismatch for %x", p)
		}
	}
}

// TestSignatureBindsEncodedBytes verifies the signature is over the
// encoded bytes: any change to the encoded form — including a
// non-canonical respelling of the same plaintext — fails verification.
func TestSignatureBindsEncodedBytes(t *testing.T) {
	plain := []byte("line\n")
	enc, sig := Seal(testKey, plain)

	// Same plaintext, non-canonical spelling: lowercase hex for LF.
	var nonCanonical []byte
	nonCanonical = append(nonCanonical, []byte("line%0a")...)
	if Verify(testKey, nonCanonical, sig) {
		t.Fatal("signature accepted non-canonical respelling")
	}
	if _, err := Open(testKey, nonCanonical, sig); !errors.Is(err, ErrSignature) {
		t.Fatalf("Open(non-canonical) = %v, want ErrSignature", err)
	}
	// And the respelling is independently rejected by the decoder.
	if _, err := DecodeString(nonCanonical); !errors.Is(err, ErrInvalid) {
		t.Fatalf("Decode(non-canonical) = %v, want ErrInvalid", err)
	}

	// Bit-flipped encoded byte.
	tampered := append([]byte(nil), enc...)
	tampered[0] ^= 0x01
	if Verify(testKey, tampered, sig) {
		t.Fatal("signature accepted tampered encoding")
	}

	// Wrong key and truncated signature.
	if Verify([]byte("other-key"), enc, sig) {
		t.Fatal("signature accepted under wrong key")
	}
	if Verify(testKey, enc, sig[:SigLen-1]) {
		t.Fatal("truncated signature accepted")
	}
}

// TestOpenTruncatedEncoding: a validly signed but truncated encoding
// surfaces ErrIncomplete from Open (sign the truncation explicitly).
func TestOpenTruncatedEncoding(t *testing.T) {
	truncated := []byte("abc%0")
	sig := Sign(testKey, truncated)
	if _, err := Open(testKey, truncated, sig); !errors.Is(err, ErrIncomplete) {
		t.Fatalf("Open(signed truncation) = %v, want ErrIncomplete", err)
	}
}
