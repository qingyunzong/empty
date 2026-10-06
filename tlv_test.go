package tlv

import (
	"bytes"
	"errors"
	"testing"
)

func mustParse(t *testing.T, data []byte) *Node {
	t.Helper()
	n, err := Parse(data)
	if err != nil {
		t.Fatalf("Parse(%x) failed: %v", data, err)
	}
	return n
}

func mustFail(t *testing.T, data []byte, kind Kind, offset int) {
	t.Helper()
	_, err := Parse(data)
	if err == nil {
		t.Fatalf("Parse(%x) succeeded, want kind %d at offset %d", data, kind, offset)
	}
	var perr *Error
	if !errors.As(err, &perr) {
		t.Fatalf("Parse(%x) error %v is not *Error", data, err)
	}
	if perr.Kind != kind || perr.Offset != offset {
		t.Fatalf("Parse(%x) = kind %d offset %d, want kind %d offset %d",
			data, perr.Kind, perr.Offset, kind, offset)
	}
}

func TestShortAndLongFormLengths(t *testing.T) {
	// Short form: primitive tag 4 (OCTET STRING), length 2.
	n := mustParse(t, []byte{0x04, 0x02, 'h', 'i'})
	if n.Constructed || n.Tag != 4 || !bytes.Equal(n.Value, []byte("hi")) {
		t.Fatalf("short form: got %+v", n)
	}

	// Long form, 1 length octet: length 128.
	doc := append([]byte{0x04, 0x81, 0x80}, bytes.Repeat([]byte{0xAA}, 128)...)
	n = mustParse(t, doc)
	if len(n.Value) != 128 {
		t.Fatalf("long form (1 octet): content len %d", len(n.Value))
	}

	// Long form, 2 length octets: length 256.
	doc = append([]byte{0x04, 0x82, 0x01, 0x00}, bytes.Repeat([]byte{0xBB}, 256)...)
	n = mustParse(t, doc)
	if len(n.Value) != 256 {
		t.Fatalf("long form (2 octets): content len %d", len(n.Value))
	}
}

func TestConstructedAndIndefinite(t *testing.T) {
	// Definite constructed SEQUENCE holding two INTEGERs.
	n := mustParse(t, []byte{0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02})
	if !n.Constructed || len(n.Children) != 2 || n.Children[1].Value[0] != 2 {
		t.Fatalf("definite constructed: got %+v", n)
	}

	// Indefinite constructed terminated by EOC.
	n = mustParse(t, []byte{0x30, 0x80, 0x02, 0x01, 0x05, 0x00, 0x00})
	if !n.Indefinite || len(n.Children) != 1 || n.Children[0].Value[0] != 5 {
		t.Fatalf("indefinite constructed: got %+v", n)
	}

	// Indefinite nested inside indefinite.
	n = mustParse(t, []byte{0x30, 0x80, 0x30, 0x80, 0x02, 0x01, 0x05, 0x00, 0x00, 0x00, 0x00})
	if len(n.Children) != 1 || len(n.Children[0].Children) != 1 {
		t.Fatalf("nested indefinite: got %+v", n)
	}
}

func TestNonMinimalLengthRejected(t *testing.T) {
	// Long form for a length below 128.
	mustFail(t, append([]byte{0x04, 0x81, 0x7F}, bytes.Repeat([]byte{0}, 127)...),
		KindNonMinimalLength, 1)
	// Leading zero octet in long form.
	mustFail(t, append([]byte{0x04, 0x82, 0x00, 0x80}, bytes.Repeat([]byte{0}, 128)...),
		KindNonMinimalLength, 1)
	// Three-octet length with leading zero.
	mustFail(t, append([]byte{0x04, 0x83, 0x00, 0x01, 0x00}, bytes.Repeat([]byte{0}, 256)...),
		KindNonMinimalLength, 1)
	// Reserved length octet.
	mustFail(t, []byte{0x04, 0xFF}, KindReservedLength, 1)
	// Length-of-length too large.
	mustFail(t, []byte{0x04, 0x89, 0x01, 0, 0, 0, 0, 0, 0, 0, 0}, KindLengthTooLarge, 1)
	// Length value overflows int64.
	mustFail(t, []byte{0x04, 0x88, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF},
		KindLengthTooLarge, 1)
}

func TestIndefiniteLengthConstructedOnly(t *testing.T) {
	mustFail(t, []byte{0x04, 0x80, 0x00, 0x00}, KindIndefinitePrimitive, 1)
	// Same inside a constructed parent.
	mustFail(t, []byte{0x30, 0x04, 0x04, 0x80, 0x00, 0x00}, KindIndefinitePrimitive, 3)
}

func TestDepthLimit(t *testing.T) {
	// Nesting: depth 0,1,2,3. Limit 2 must reject the depth-3 item at offset 6.
	deep := []byte{0x30, 0x06, 0x30, 0x04, 0x30, 0x02, 0x30, 0x00}
	if _, err := ParseDepth(deep, 3); err != nil {
		t.Fatalf("depth 3 within limit 3: %v", err)
	}
	_, err := ParseDepth(deep, 2)
	var perr *Error
	if !errors.As(err, &perr) || perr.Kind != KindDepthExceeded || perr.Offset != 6 {
		t.Fatalf("depth limit: got %v, want KindDepthExceeded at 6", err)
	}
}

func TestChildCrossesParentBoundary(t *testing.T) {
	// Parent content is 3 bytes, but the child at offset 2 claims 5 content bytes.
	mustFail(t, []byte{0x30, 0x03, 0x02, 0x05, 0x05, 0x00, 0x00}, KindBoundary, 2)
	// Indefinite child whose EOC lies past the definite parent's end.
	mustFail(t, []byte{0x30, 0x06, 0x30, 0x80, 0x02, 0x01, 0x05, 0x00, 0x00, 0x00}, KindBoundary, 2)
	// EOC outside any indefinite-length item.
	mustFail(t, []byte{0x00, 0x00}, KindUnexpectedEOC, 0)
	mustFail(t, []byte{0x30, 0x02, 0x00, 0x00}, KindUnexpectedEOC, 2)
	// Trailing bytes after a complete top-level item.
	mustFail(t, []byte{0x02, 0x01, 0x05, 0x00}, KindTrailingData, 3)
}

func TestTruncationErrorOffsets(t *testing.T) {
	// Valid document: definite SEQUENCE containing an INTEGER, an OCTET
	// STRING, and an indefinite-length SEQUENCE holding one INTEGER.
	doc := []byte{
		0x30, 0x0E,
		0x02, 0x01, 0x05,
		0x04, 0x02, 'h', 'i',
		0x30, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00,
	}
	if _, err := Parse(doc); err != nil {
		t.Fatalf("full document must parse: %v", err)
	}
	// Every proper prefix must fail as truncated exactly at len(prefix).
	for i := 0; i < len(doc); i++ {
		_, err := Parse(doc[:i])
		var perr *Error
		if !errors.As(err, &perr) {
			t.Fatalf("prefix %d: no parse error", i)
		}
		if perr.Kind != KindTruncated || perr.Offset != i {
			t.Fatalf("prefix %d: got kind %d offset %d, want KindTruncated at %d",
				i, perr.Kind, perr.Offset, i)
		}
	}
}

func TestRoundTrip(t *testing.T) {
	docs := [][]byte{
		{0x02, 0x01, 0x05}, // primitive short form
		{0x04, 0x00},       // empty primitive
		{0x30, 0x00},       // empty constructed
		{0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02},                           // definite constructed
		{0x30, 0x80, 0x02, 0x01, 0x05, 0x00, 0x00},                                 // indefinite constructed
		{0x30, 0x80, 0x30, 0x80, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00},               // nested indefinite
		{0xA0, 0x03, 0x02, 0x01, 0x05},                                             // context-specific constructed
		{0x1F, 0x81, 0x00, 0x01, 0x05},                                             // high-tag-number form
		append([]byte{0x04, 0x81, 0x80}, bytes.Repeat([]byte{0xAA}, 128)...),       // long form, 1 octet
		append([]byte{0x04, 0x82, 0x01, 0x00}, bytes.Repeat([]byte{0xBB}, 256)...), // long form, 2 octets
		{ // mixed tree
			0x30, 0x0E,
			0x02, 0x01, 0x05,
			0x04, 0x02, 'h', 'i',
			0x30, 0x80, 0x02, 0x01, 0x01, 0x00, 0x00,
		},
	}
	for i, doc := range docs {
		n, err := Parse(doc)
		if err != nil {
			t.Fatalf("doc %d: parse failed: %v", i, err)
		}
		if got := n.Encode(); !bytes.Equal(got, doc) {
			t.Fatalf("doc %d: round trip mismatch\n got %x\nwant %x", i, got, doc)
		}
	}
}
