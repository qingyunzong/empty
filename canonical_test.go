package q213

import (
	"bytes"
	"testing"
)

func be32(value uint32) []byte {
	return []byte{byte(value >> 24), byte(value >> 16), byte(value >> 8), byte(value)}
}

func stream(parts ...[]byte) []byte {
	return bytes.Join(parts, nil)
}

func expanded(namespace, local string) []byte {
	return stream(be32(uint32(len(namespace))), []byte(namespace),
		be32(uint32(len(local))), []byte(local))
}

func TestCanonicalElementAndText(t *testing.T) {
	root, err := Parse([]byte(`<Order xmlns="urn:shop"><Item>tea</Item></Order>`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	want := stream(
		[]byte("E"),
		expanded("urn:shop", "Order"),
		be32(0),
		[]byte("E"),
		expanded("urn:shop", "Item"),
		be32(0),
		[]byte("T"),
		be32(3),
		[]byte("tea"),
		[]byte("Z"),
		[]byte("Z"),
	)
	if got := Canonical(root); !bytes.Equal(got, want) {
		t.Fatalf("canonical stream mismatch\n got: %x\nwant: %x", got, want)
	}
}

func TestCanonicalAttributesSortedByExpandedName(t *testing.T) {
	root, err := Parse([]byte(
		`<e xmlns:n="urn:n" b="2" n:a="1" a="0" n:z="3"></e>`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}

	type attr struct {
		ns, local, value string
	}
	wantAttrs := []attr{
		{"", "a", "0"},
		{"", "b", "2"},
		{"urn:n", "a", "1"},
		{"urn:n", "z", "3"},
	}
	var want = stream([]byte("E"), expanded("", "e"), be32(uint32(len(wantAttrs))))
	for _, a := range wantAttrs {
		want = stream(want, expanded(a.ns, a.local),
			be32(uint32(len(a.value))), []byte(a.value))
	}
	want = stream(want, []byte("Z"))

	if got := Canonical(root); !bytes.Equal(got, want) {
		t.Fatalf("attribute ordering mismatch\n got: %x\nwant: %x", got, want)
	}
}

func TestCanonicalPrefixRenamesAreInvisible(t *testing.T) {
	first, err := Parse([]byte(`<p:Order xmlns:p="urn:shop"><p:Item>tea</p:Item></p:Order>`))
	if err != nil {
		t.Fatalf("Parse first: %v", err)
	}
	second, err := Parse([]byte(`<x:Order xmlns:x="urn:shop"><x:Item>tea</x:Item></x:Order>`))
	if err != nil {
		t.Fatalf("Parse second: %v", err)
	}
	if got, want := Canonical(first), Canonical(second); !bytes.Equal(got, want) {
		t.Fatalf("prefix rename changed the canonical stream\nfirst:  %x\nsecond: %x", got, want)
	}
}

func TestCanonicalEmptyElement(t *testing.T) {
	root, err := Parse([]byte(`<empty/>`))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	want := stream([]byte("E"), expanded("", "empty"), be32(0), []byte("Z"))
	if got := Canonical(root); !bytes.Equal(got, want) {
		t.Fatalf("got %x, want %x", got, want)
	}
}
