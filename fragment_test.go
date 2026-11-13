package dataeng_test

import (
	"errors"
	"strings"
	"testing"

	"example.org/dataeng13/q0077"
)

func TestExternalEntitiesAreRejected(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{
			name: "external general entity",
			src:  `<!DOCTYPE root [<!ENTITY ext SYSTEM "file:///etc/hostname">]><root>&ext;</root>`,
		},
		{
			name: "public general entity",
			src:  `<!DOCTYPE root [<!ENTITY ext PUBLIC "-//EXAMPLE//DTD X//EN" "https://example.invalid/x.dtd">]><root>&ext;</root>`,
		},
		{
			name: "external entity declared but unused",
			src:  `<!DOCTYPE root [<!ENTITY ext SYSTEM "file:///etc/hostname">]><root/>`,
		},
		{
			name: "external DTD subset",
			src:  `<!DOCTYPE root SYSTEM "https://example.invalid/root.dtd"><root/>`,
		},
		{
			name: "public DTD subset",
			src:  `<!DOCTYPE root PUBLIC "-//EXAMPLE//DTD X//EN" "https://example.invalid/root.dtd"><root/>`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := dataeng.ParseFragment([]byte(test.src), 1024)
			if !errors.Is(err, dataeng.ErrExternalEntity) {
				t.Fatalf("ParseFragment() error = %v, want ErrExternalEntity", err)
			}
		})
	}
}

func TestInternalEntityExpansionLimit(t *testing.T) {
	tests := []struct {
		name     string
		src      string
		limit    int
		wantErr  bool
		wantText string
		wantAttr string
	}{
		{
			name:    "one byte below the replacement length",
			src:     `<!DOCTYPE root [<!ENTITY e "12345">]><root>&e;</root>`,
			limit:   4,
			wantErr: true,
		},
		{
			name:     "exactly the replacement length",
			src:      `<!DOCTYPE root [<!ENTITY e "12345">]><root>&e;</root>`,
			limit:    5,
			wantText: "12345",
		},
		{
			name:    "nested replacement one byte below the total",
			src:     `<!DOCTYPE root [<!ENTITY a "12345"><!ENTITY b "&a;&a;">]><root>&b;</root>`,
			limit:   9,
			wantErr: true,
		},
		{
			name:     "nested replacement exactly at the total",
			src:      `<!DOCTYPE root [<!ENTITY a "12345"><!ENTITY b "&a;&a;">]><root>&b;</root>`,
			limit:    10,
			wantText: "1234512345",
		},
		{
			name:    "total across references is bounded",
			src:     `<!DOCTYPE root [<!ENTITY e "abcde">]><root>&e;&e;</root>`,
			limit:   9,
			wantErr: true,
		},
		{
			name:     "two references at the total",
			src:      `<!DOCTYPE root [<!ENTITY e "abcde">]><root>&e;&e;</root>`,
			limit:    10,
			wantText: "abcdeabcde",
		},
		{
			name:    "attribute expansion is bounded",
			src:     `<!DOCTYPE r [<!ENTITY v "abc">]><r a="&v;"/>`,
			limit:   2,
			wantErr: true,
		},
		{
			name:     "attribute expansion fits",
			src:      `<!DOCTYPE r [<!ENTITY v "abc">]><r a="&v;"/>`,
			limit:    3,
			wantAttr: "abc",
		},
		{
			name:     "empty entity with a zero limit",
			src:      `<!DOCTYPE r [<!ENTITY e "">]><r>[&e;]</r>`,
			limit:    0,
			wantText: "[]",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fragment, err := dataeng.ParseFragment([]byte(test.src), test.limit)
			if test.wantErr {
				if !errors.Is(err, dataeng.ErrExpansionLimit) {
					t.Fatalf("ParseFragment() error = %v, want ErrExpansionLimit", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("ParseFragment() error = %v", err)
			}
			root := fragment.Root()
			if root == nil {
				t.Fatal("ParseFragment() returned no root element")
			}
			if got := root.TextContent(); got != test.wantText {
				t.Fatalf("text = %q, want %q", got, test.wantText)
			}
			if test.wantAttr != "" {
				if len(root.Attrs) != 1 || root.Attrs[0].Value != test.wantAttr {
					t.Fatalf("attributes = %#v, want one value %q", root.Attrs, test.wantAttr)
				}
			}
		})
	}
}

func TestRecursiveEntityIsRejected(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{
			name: "self reference",
			src:  `<!DOCTYPE r [<!ENTITY a "&a;">]><r>&a;</r>`,
		},
		{
			name: "mutual reference",
			src:  `<!DOCTYPE r [<!ENTITY a "&b;"><!ENTITY b "&a;">]><r>&a;</r>`,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := dataeng.ParseFragment([]byte(test.src), 1024)
			if !errors.Is(err, dataeng.ErrEntityLoop) {
				t.Fatalf("ParseFragment() error = %v, want ErrEntityLoop", err)
			}
		})
	}
}

func TestPredefinedAndCharacterReferencesAreNotExpansion(t *testing.T) {
	fragment, err := dataeng.ParseFragment([]byte(`<r>&amp;&#65;</r>`), 0)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	root := fragment.Root()
	if root == nil {
		t.Fatal("ParseFragment() returned no root element")
	}
	if got := root.TextContent(); got != "&A" {
		t.Fatalf("text = %q, want %q", got, "&A")
	}
}

func TestDefaultNamespaceScope(t *testing.T) {
	fragment, err := dataeng.ParseFragment([]byte(`<r xmlns="urn:one"><child/></r><sibling/>`), 0)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	elements := fragment.Elements()
	if len(elements) != 2 {
		t.Fatalf("top-level elements = %d, want 2", len(elements))
	}

	root := elements[0]
	if root.Name.Space != "urn:one" || root.Name.Local != "r" {
		t.Fatalf("root name = %#v, want {%q %q}", root.Name, "urn:one", "r")
	}
	child := root.Children[0]
	if child.Name.Space != "urn:one" || child.Name.Local != "child" {
		t.Fatalf("child name = %#v, want {%q %q}", child.Name, "urn:one", "child")
	}

	sibling := elements[1]
	if sibling.Name.Space != "" || sibling.Name.Local != "sibling" {
		t.Fatalf("sibling name = %#v, want {%q %q}", sibling.Name, "", "sibling")
	}
}

func TestDefaultNamespaceCanBeClearedForSubtree(t *testing.T) {
	fragment, err := dataeng.ParseFragment([]byte(`<r xmlns="urn:one"><a xmlns=""><b/></a><c/></r>`), 0)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	root := fragment.Root()
	if root.Name.Space != "urn:one" {
		t.Fatalf("root namespace = %q, want %q", root.Name.Space, "urn:one")
	}

	a := root.Children[0]
	if a.Name.Space != "" {
		t.Fatalf("a namespace = %q, want empty", a.Name.Space)
	}
	b := a.Children[0]
	if b.Name.Space != "" {
		t.Fatalf("b namespace = %q, want empty", b.Name.Space)
	}

	c := root.Children[1]
	if c.Name.Space != "urn:one" {
		t.Fatalf("c namespace = %q, want %q", c.Name.Space, "urn:one")
	}
}

func TestPrefixedNamespaces(t *testing.T) {
	fragment, err := dataeng.ParseFragment(
		[]byte(`<r xmlns:p="urn:p" p:a="1"><p:c p:d="2"/></r>`),
		0,
	)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	root := fragment.Root()
	if root.Name.Space != "" || root.Name.Local != "r" {
		t.Fatalf("root name = %#v, want {%q %q}", root.Name, "", "r")
	}
	if len(root.Attrs) != 1 {
		t.Fatalf("root attributes = %d, want 1", len(root.Attrs))
	}
	attr := root.Attrs[0]
	if attr.Name.Space != "urn:p" || attr.Name.Local != "a" || attr.Prefix != "p" || attr.Value != "1" {
		t.Fatalf("attribute = %#v, want namespace %q local %q prefix %q value %q", attr, "urn:p", "a", "p", "1")
	}

	child := root.Children[0]
	if child.Name.Space != "urn:p" || child.Name.Local != "c" || child.Prefix != "p" {
		t.Fatalf("child name = %#v, want namespace %q local %q prefix %q", child.Name, "urn:p", "c", "p")
	}
	if len(child.Attrs) != 1 || child.Attrs[0].Name.Space != "urn:p" || child.Attrs[0].Name.Local != "d" {
		t.Fatalf("child attributes = %#v, want one attribute in urn:p:d", child.Attrs)
	}
}

func TestDefaultNamespaceDoesNotApplyToAttributes(t *testing.T) {
	fragment, err := dataeng.ParseFragment([]byte(`<r xmlns="urn:one" a="1"/>`), 0)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	root := fragment.Root()
	if root.Name.Space != "urn:one" {
		t.Fatalf("root namespace = %q, want %q", root.Name.Space, "urn:one")
	}
	if len(root.Attrs) != 1 {
		t.Fatalf("root attributes = %d, want 1", len(root.Attrs))
	}
	if root.Attrs[0].Name.Space != "" || root.Attrs[0].Name.Local != "a" {
		t.Fatalf("attribute name = %#v, want {%q %q}", root.Attrs[0].Name, "", "a")
	}
}

func TestXMLPrefixIsImplicitlyDeclared(t *testing.T) {
	fragment, err := dataeng.ParseFragment([]byte(`<r xml:lang="en"/>`), 0)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	root := fragment.Root()
	if len(root.Attrs) != 1 {
		t.Fatalf("root attributes = %d, want 1", len(root.Attrs))
	}
	attr := root.Attrs[0]
	if attr.Name.Space != "http://www.w3.org/XML/1998/namespace" || attr.Name.Local != "lang" {
		t.Fatalf("attribute name = %#v, want XML namespace lang", attr.Name)
	}
}

func TestUndeclaredPrefixesFail(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{name: "element prefix", src: `<p:r/>`},
		{name: "attribute prefix", src: `<r p:a="1"/>`},
		{name: "prefix out of scope for later sibling", src: `<r xmlns:p="urn:p"><p:c/></r><p:s/>`},
		{name: "prefix out of scope inside parent", src: `<r><a xmlns:p="urn:p"><p:c/></a><p:d/></r>`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := dataeng.ParseFragment([]byte(test.src), 0)
			if !errors.Is(err, dataeng.ErrUndeclaredPrefix) {
				t.Fatalf("ParseFragment() error = %v, want ErrUndeclaredPrefix", err)
			}
		})
	}
}

func TestDeclaredPrefixWithinElementSucceeds(t *testing.T) {
	fragment, err := dataeng.ParseFragment([]byte(`<r xmlns:p="urn:p"><p:c/></r>`), 0)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	root := fragment.Root()
	child := root.Children[0]
	if child.Name.Space != "urn:p" || child.Name.Local != "c" {
		t.Fatalf("child name = %#v, want {%q %q}", child.Name, "urn:p", "c")
	}
}

func TestPrefixDeclarationsFollowElementScope(t *testing.T) {
	fragment, err := dataeng.ParseFragment(
		[]byte(`<r xmlns:p="urn:p"><a xmlns:p="urn:q"><p:c/></a><p:d/></r>`),
		0,
	)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	root := fragment.Root()
	a := root.Children[0]
	c := a.Children[0]
	if c.Name.Space != "urn:q" {
		t.Fatalf("c namespace = %q, want %q", c.Name.Space, "urn:q")
	}
	d := root.Children[1]
	if d.Name.Space != "urn:p" {
		t.Fatalf("d namespace = %q, want %q", d.Name.Space, "urn:p")
	}
}

func TestNamespaceDeclarationAppliesToEarlierAttributes(t *testing.T) {
	fragment, err := dataeng.ParseFragment([]byte(`<r p:a="1" xmlns:p="urn:p"/>`), 0)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	root := fragment.Root()
	if len(root.Attrs) != 1 || root.Attrs[0].Name.Space != "urn:p" {
		t.Fatalf("attributes = %#v, want one attribute in urn:p", root.Attrs)
	}
}

func TestReadFragmentAndLimits(t *testing.T) {
	fragment, err := dataeng.ReadFragment(strings.NewReader(`<r><c/></r>`), 0)
	if err != nil {
		t.Fatalf("ReadFragment() error = %v", err)
	}
	if root := fragment.Root(); root == nil || root.Name.Local != "r" {
		t.Fatalf("root = %#v, want local %q", root, "r")
	}

	_, err = dataeng.ParseFragment([]byte(`<r/>`), -1)
	if !errors.Is(err, dataeng.ErrInvalidLimit) {
		t.Fatalf("ParseFragment() error = %v, want ErrInvalidLimit", err)
	}
}

func TestXMLDeclarationAndBOM(t *testing.T) {
	fragment, err := dataeng.ParseFragment(
		[]byte("\ufeff<?xml version=\"1.0\" encoding=\"UTF-8\"?><r xmlns=\"urn:x\"/>"),
		0,
	)
	if err != nil {
		t.Fatalf("ParseFragment() error = %v", err)
	}
	root := fragment.Root()
	if root == nil || root.Name.Space != "urn:x" || root.Name.Local != "r" {
		t.Fatalf("root = %#v, want namespace %q local %q", root, "urn:x", "r")
	}
}

func TestUndefinedEntityFails(t *testing.T) {
	_, err := dataeng.ParseFragment([]byte(`<r>&missing;</r>`), 0)
	if !errors.Is(err, dataeng.ErrUndefinedEntity) {
		t.Fatalf("ParseFragment() error = %v, want ErrUndefinedEntity", err)
	}
}

func TestMalformedFragmentFails(t *testing.T) {
	tests := []struct {
		name string
		src  string
	}{
		{name: "unclosed element", src: `<r>`},
		{name: "mismatched end tag", src: `<r></s>`},
		{name: "duplicate attribute", src: `<r a="1" a="2"/>`},
		{name: "duplicate expanded attribute", src: `<r xmlns:p="urn:x" xmlns:q="urn:x" p:a="1" q:a="2"/>`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := dataeng.ParseFragment([]byte(test.src), 0)
			if !errors.Is(err, dataeng.ErrMalformed) {
				t.Fatalf("ParseFragment() error = %v, want ErrMalformed", err)
			}
		})
	}
}
