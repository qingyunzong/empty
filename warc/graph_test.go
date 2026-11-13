package warc

import (
	"crypto/sha1"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func sha1Hex(content string) string {
	return fmt.Sprintf("sha1:%X", sha1.Sum([]byte(content)))
}

func mustAdd(t *testing.T, g *Graph, recs ...*Record) {
	t.Helper()
	for _, r := range recs {
		if err := g.Add(r); err != nil {
			t.Fatalf("Add(%q): %v", r.ID, err)
		}
	}
}

func TestLinksResponseRequestConversion(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeRequest, ID: "<req>"},
		&Record{Type: TypeResponse, ID: "<resp>", RefersTo: "<req>"},
		&Record{Type: TypeConversion, ID: "<conv>", RefersTo: "<resp>"},
	)
	if err := g.Resolve(); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if tgt, ok := g.RefersTo("<resp>"); !ok || tgt.ID != "<req>" {
		t.Fatalf("RefersTo(<resp>) = %v, %v", tgt, ok)
	}
	refs := g.Referrers("<resp>")
	if len(refs) != 1 || refs[0].ID != "<conv>" {
		t.Fatalf("Referrers(<resp>) = %v", refs)
	}
}

func TestRevisitVerifiedOriginal(t *testing.T) {
	payload := "<html>archived</html>"
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<orig>", PayloadDigest: sha1Hex(payload), Content: []byte(payload)},
		&Record{Type: TypeRevisit, ID: "<rev>", RefersTo: "<orig>", PayloadDigest: strings.ToLower(sha1Hex(payload))},
	)
	if err := g.Resolve(); err != nil {
		t.Fatalf("Resolve: %v", err)
	}
}

func TestRevisitDigestMismatch(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<orig>", PayloadDigest: sha1Hex("a"), Content: []byte("a")},
		&Record{Type: TypeRevisit, ID: "<rev>", RefersTo: "<orig>", PayloadDigest: sha1Hex("b")},
	)
	if err := g.Resolve(); !errors.Is(err, ErrPayloadDigestMismatch) {
		t.Fatalf("Resolve = %v, want ErrPayloadDigestMismatch", err)
	}
}

func TestRevisitMissingTarget(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeRevisit, ID: "<rev>", RefersTo: "<elsewhere>", PayloadDigest: sha1Hex("a")},
	)
	if err := g.Resolve(); !errors.Is(err, ErrMissingReference) {
		t.Fatalf("Resolve = %v, want ErrMissingReference", err)
	}
}

func TestRevisitChainRejected(t *testing.T) {
	payload := "x"
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<orig>", PayloadDigest: sha1Hex(payload), Content: []byte(payload)},
		&Record{Type: TypeRevisit, ID: "<rev1>", RefersTo: "<orig>", PayloadDigest: sha1Hex(payload)},
		&Record{Type: TypeRevisit, ID: "<rev2>", RefersTo: "<rev1>", PayloadDigest: sha1Hex(payload)},
	)
	if err := g.Resolve(); !errors.Is(err, ErrRevisitTargetNotOriginal) {
		t.Fatalf("Resolve = %v, want ErrRevisitTargetNotOriginal", err)
	}
}

func TestRevisitUnverifiedOriginal(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<orig>"},
		&Record{Type: TypeRevisit, ID: "<rev>", RefersTo: "<orig>", PayloadDigest: sha1Hex("a")},
	)
	if err := g.Resolve(); !errors.Is(err, ErrUnverifiedOriginal) {
		t.Fatalf("Resolve = %v, want ErrUnverifiedOriginal", err)
	}
}

func TestOriginalDigestTampered(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeResponse, ID: "<orig>", PayloadDigest: sha1Hex("a"), Content: []byte("tampered")},
	)
	if err := g.Resolve(); !errors.Is(err, ErrPayloadDigestMismatch) {
		t.Fatalf("Resolve = %v, want ErrPayloadDigestMismatch", err)
	}
}

func TestReferenceCycle(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g,
		&Record{Type: TypeConversion, ID: "<a>", RefersTo: "<b>"},
		&Record{Type: TypeConversion, ID: "<b>", RefersTo: "<a>"},
	)
	if err := g.Resolve(); !errors.Is(err, ErrReferenceCycle) {
		t.Fatalf("Resolve = %v, want ErrReferenceCycle", err)
	}
}

func TestSelfReferenceCycle(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g, &Record{Type: TypeConversion, ID: "<a>", RefersTo: "<a>"})
	if err := g.Resolve(); !errors.Is(err, ErrReferenceCycle) {
		t.Fatalf("Resolve = %v, want ErrReferenceCycle", err)
	}
}

func TestDuplicateRecordID(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g, &Record{Type: TypeResponse, ID: "<a>"})
	if err := g.Add(&Record{Type: TypeRequest, ID: "<a>"}); !errors.Is(err, ErrDuplicateRecordID) {
		t.Fatalf("Add = %v, want ErrDuplicateRecordID", err)
	}
}

func TestConcurrentToMissing(t *testing.T) {
	g := NewGraph()
	mustAdd(t, g, &Record{Type: TypeResponse, ID: "<a>", ConcurrentTo: []string{"<nope>"}})
	if err := g.Resolve(); !errors.Is(err, ErrMissingReference) {
		t.Fatalf("Resolve = %v, want ErrMissingReference", err)
	}
}
