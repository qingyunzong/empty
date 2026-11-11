package batchresp

import (
	"errors"
	"reflect"
	"testing"
)

func TestParseRefRFC6901(t *testing.T) {
	ref, err := ParseRef("seg#/a~1b/0/c~0d")
	if err != nil {
		t.Fatalf("ParseRef: %v", err)
	}
	if ref.ID != "seg" {
		t.Fatalf("unexpected ID %q", ref.ID)
	}
	wantTokens := []string{"a/b", "0", "c~d"}
	if !reflect.DeepEqual(ref.tokens, wantTokens) {
		t.Fatalf("tokens = %v, want %v", ref.tokens, wantTokens)
	}

	doc := mustJSON(t, `{"a/b":[{"c~d":42}]}`)
	got, err := evalPointer(doc, ref.tokens)
	if err != nil {
		t.Fatalf("evalPointer: %v", err)
	}
	if got != float64(42) {
		t.Fatalf("resolved = %v, want 42", got)
	}

	whole, err := ParseRef("seg#")
	if err != nil {
		t.Fatalf("empty pointer: %v", err)
	}
	if len(whole.tokens) != 0 {
		t.Fatalf("empty pointer should have no tokens, got %v", whole.tokens)
	}

	for _, bad := range []string{"", "nohash", "#/x", "s#/a~2", "s#/a/~x"} {
		_, err := ParseRef(bad)
		if err == nil {
			t.Fatalf("expected error for reference %q", bad)
		}
		if !errors.Is(err, ErrInvalidRef) {
			t.Fatalf("reference %q: expected ErrInvalidRef, got %v", bad, err)
		}
	}
}

func TestEvalPointerArrayAndObjectErrors(t *testing.T) {
	doc := mustJSON(t, `{"arr":[1,2,3],"obj":{"k":"v"}}`)
	if _, err := evalPointer(doc, []string{"arr", "9"}); !errors.Is(err, ErrInvalidRef) {
		t.Fatalf("out-of-range index: got %v", err)
	}
	if _, err := evalPointer(doc, []string{"arr", "01"}); !errors.Is(err, ErrInvalidRef) {
		t.Fatalf("leading-zero index: got %v", err)
	}
	if _, err := evalPointer(doc, []string{"arr", "-"}); !errors.Is(err, ErrInvalidRef) {
		t.Fatalf("append index '-': got %v", err)
	}
	if _, err := evalPointer(doc, []string{"obj", "missing"}); !errors.Is(err, ErrInvalidRef) {
		t.Fatalf("missing key: got %v", err)
	}
	if _, err := evalPointer(doc, []string{"arr", "0", "deep"}); !errors.Is(err, ErrInvalidRef) {
		t.Fatalf("scalar traversal: got %v", err)
	}
}
