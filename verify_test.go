package q213

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"testing"
)

type signerFixture struct {
	public  ed25519.PublicKey
	private ed25519.PrivateKey
}

func newSignerFixture(t *testing.T) *signerFixture {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	return &signerFixture{public: public, private: private}
}

func (f *signerFixture) signPayload(payloadXML string) (string, string) {
	root, err := Parse([]byte(payloadXML))
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(Canonical(root))
	signature := ed25519.Sign(f.private, sum[:])
	return base64.StdEncoding.EncodeToString(sum[:]),
		base64.StdEncoding.EncodeToString(signature)
}

func (f *signerFixture) envelope(inner string) []byte {
	return []byte(`<Envelope xmlns="urn:gsb:xmlmsg:v1">` + inner + `</Envelope>`)
}

func (f *signerFixture) signatureBlock(id, digest, signature string) string {
	return `<Signature>` +
		`<Reference URI="#` + id + `">` +
		`<DigestValue>` + digest + `</DigestValue>` +
		`</Reference>` +
		`<SignatureValue>` + signature + `</SignatureValue>` +
		`</Signature>`
}

func TestVerifyAcceptsValidMessageAndDeliversOnlyPayload(t *testing.T) {
	fixture := newSignerFixture(t)
	payload := `<Order Id="order-1" xmlns="urn:shop"><Item qty="2">tea</Item></Order>`
	digest, signature := fixture.signPayload(payload)
	message := fixture.envelope(payload + fixture.signatureBlock("order-1", digest, signature))

	verifier, err := NewVerifier(fixture.public)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	called := false
	err = verifier.Verify(message, func(node *Node) error {
		called = true
		if node.Namespace != "urn:shop" || node.Local != "Order" {
			t.Fatalf("handler received %s{%s}, want urn:shop{Order}", node.Namespace, node.Local)
		}
		id, ok := node.Attribute("", "Id")
		if !ok || id != "order-1" {
			t.Fatalf("handler node Id = %q, %v", id, ok)
		}
		if got := node.TextContent(); got != "tea" {
			t.Fatalf("handler text = %q, want tea", got)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	if !called {
		t.Fatal("handler was not invoked")
	}
}

func TestVerifyAcceptsPrefixRename(t *testing.T) {
	fixture := newSignerFixture(t)
	// Id stays unprefixed (the referenced identifier); only element prefixes move.
	signed := `<p:Order Id="order-2" xmlns:p="urn:shop"><p:Item>tea</p:Item></p:Order>`
	delivered := `<z:Order Id="order-2" xmlns:z="urn:shop"><z:Item>tea</z:Item></z:Order>`

	digest, signature := fixture.signPayload(signed)
	message := fixture.envelope(delivered + fixture.signatureBlock("order-2", digest, signature))

	verifier, _ := NewVerifier(fixture.public)
	err := verifier.Verify(message, func(node *Node) error {
		if node.Namespace != "urn:shop" || node.Local != "Order" {
			t.Fatalf("unexpected handler node %s{%s}", node.Namespace, node.Local)
		}
		return nil
	})
	if err != nil {
		t.Fatalf("prefix-preserving rename should verify: %v", err)
	}
}

func TestVerifyRejectsTextChange(t *testing.T) {
	fixture := newSignerFixture(t)
	signed := `<Order Id="order-3" xmlns="urn:shop"><Item>tea</Item></Order>`
	tampered := `<Order Id="order-3" xmlns="urn:shop"><Item>coffee</Item></Order>`

	digest, signature := fixture.signPayload(signed)
	message := fixture.envelope(tampered + fixture.signatureBlock("order-3", digest, signature))

	verifier, _ := NewVerifier(fixture.public)
	err := verifier.Verify(message, func(node *Node) error {
		t.Fatal("handler must not run when the digest mismatches")
		return nil
	})
	if !errors.Is(err, ErrDigest) {
		t.Fatalf("got %v, want ErrDigest", err)
	}
}

func TestVerifyRejectsDuplicateIDs(t *testing.T) {
	fixture := newSignerFixture(t)
	payload := `<Order Id="dup" xmlns="urn:shop">
		<Item Id="dup">tea</Item>
	</Order>`
	digest, signature := fixture.signPayload(payload)
	message := fixture.envelope(payload + fixture.signatureBlock("dup", digest, signature))

	verifier, _ := NewVerifier(fixture.public)
	err := verifier.Verify(message, func(node *Node) error {
		t.Fatal("handler must not run with duplicate Ids")
		return nil
	})
	if !errors.Is(err, ErrDuplicateID) {
		t.Fatalf("got %v, want ErrDuplicateID", err)
	}
}

func TestVerifyRejectsTwoPayloadElements(t *testing.T) {
	fixture := newSignerFixture(t)
	real := `<Order Id="real" xmlns="urn:shop"><Item>tea</Item></Order>`
	decoy := `<Decoy Id="decoy-1" xmlns="urn:evil"><Item>attack</Item></Decoy>`

	digest, signature := fixture.signPayload(decoy)
	// A validly signed decoy still cannot be accepted as a second Payload.
	message := fixture.envelope(real + decoy +
		fixture.signatureBlock("decoy-1", digest, signature))

	verifier, _ := NewVerifier(fixture.public)
	err := verifier.Verify(message, func(node *Node) error {
		t.Fatalf("handler must not run; wrapping node: %s{%s}", node.Namespace, node.Local)
		return nil
	})
	if !errors.Is(err, ErrPayloadStructure) {
		t.Fatalf("got %v, want ErrPayloadStructure", err)
	}
}

func TestVerifyRejectsReferenceToNestedElement(t *testing.T) {
	fixture := newSignerFixture(t)
	// The Reference points at a descendant instead of the Payload element:
	// the verifier must never verify one node and hand another to the handler.
	payload := `<Order Id="main" xmlns="urn:shop"><Item Id="inner">tea</Item></Order>`
	digest, signature := fixture.signPayload(payload)
	message := fixture.envelope(payload +
		fixture.signatureBlock("inner", digest, signature))

	verifier, _ := NewVerifier(fixture.public)
	err := verifier.Verify(message, func(node *Node) error {
		t.Fatalf("handler must not consume %s{%s}", node.Namespace, node.Local)
		return nil
	})
	if !errors.Is(err, ErrReference) {
		t.Fatalf("got %v, want ErrReference", err)
	}
}

func TestVerifyRejectsSignatureInsidePayload(t *testing.T) {
	fixture := newSignerFixture(t)
	payload := `<Order Id="order-4" xmlns="urn:shop" xmlns:m="urn:gsb:xmlmsg:v1">
		<Item>tea</Item>
		<m:Signature>
			<m:Reference URI="#order-4"><m:DigestValue>x</m:DigestValue></m:Reference>
			<m:SignatureValue>y</m:SignatureValue>
		</m:Signature>
	</Order>`

	verifier, _ := NewVerifier(fixture.public)
	err := verifier.Verify([]byte(`<Envelope xmlns="urn:gsb:xmlmsg:v1">`+payload+`</Envelope>`),
		func(node *Node) error {
			t.Fatal("handler must not run when the Signature is inside the Payload")
			return nil
		})
	if !errors.Is(err, ErrSignatureStructure) {
		t.Fatalf("got %v, want ErrSignatureStructure", err)
	}
}

func TestVerifyRejectsForgedSignature(t *testing.T) {
	fixture := newSignerFixture(t)
	payload := `<Order Id="order-5" xmlns="urn:shop"><Item>tea</Item></Order>`
	digest, _ := fixture.signPayload(payload)
	_, attackerPrivate, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}
	forged := ed25519.Sign(attackerPrivate, mustDigest(t, payload))

	message := fixture.envelope(payload + fixture.signatureBlock("order-5", digest,
		base64.StdEncoding.EncodeToString(forged)))
	verifier, _ := NewVerifier(fixture.public)
	err = verifier.Verify(message, func(node *Node) error {
		t.Fatal("handler must not run for a forged signature")
		return nil
	})
	if !errors.Is(err, ErrSignature) {
		t.Fatalf("got %v, want ErrSignature", err)
	}
}

func TestVerifyRejectsMultipleSignatures(t *testing.T) {
	fixture := newSignerFixture(t)
	payload := `<Order Id="order-6" xmlns="urn:shop"><Item>tea</Item></Order>`
	digest, signature := fixture.signPayload(payload)
	block := fixture.signatureBlock("order-6", digest, signature)
	message := fixture.envelope(payload + block + block)

	verifier, _ := NewVerifier(fixture.public)
	err := verifier.Verify(message, func(node *Node) error {
		t.Fatal("handler must not run with two Signatures")
		return nil
	})
	if !errors.Is(err, ErrSignatureStructure) {
		t.Fatalf("got %v, want ErrSignatureStructure", err)
	}
}

func TestVerifyRejectsDanglingReference(t *testing.T) {
	fixture := newSignerFixture(t)
	payload := `<Order Id="order-7" xmlns="urn:shop"><Item>tea</Item></Order>`
	digest, signature := fixture.signPayload(payload)
	message := fixture.envelope(payload + fixture.signatureBlock("missing", digest, signature))

	verifier, _ := NewVerifier(fixture.public)
	err := verifier.Verify(message, func(node *Node) error {
		t.Fatal("handler must not run when the Reference does not resolve")
		return nil
	})
	if !errors.Is(err, ErrReference) {
		t.Fatalf("got %v, want ErrReference", err)
	}
}

func TestVerifyRejectsRestrictedSubsetViolations(t *testing.T) {
	fixture := newSignerFixture(t)
	verifier, _ := NewVerifier(fixture.public)

	cases := []struct {
		name string
		data []byte
		want error
	}{
		{"comment", []byte(`<Envelope xmlns="urn:gsb:xmlmsg:v1"><!-- nope --></Envelope>`), ErrComment},
		{"processing instruction", []byte(`<Envelope xmlns="urn:gsb:xmlmsg:v1"><?app run?></Envelope>`), ErrProcessingInstruction},
		{"doctype", []byte(`<!DOCTYPE Envelope><Envelope xmlns="urn:gsb:xmlmsg:v1"></Envelope>`), ErrDTD},
		{"late xml declaration", []byte(`<Envelope xmlns="urn:gsb:xmlmsg:v1"><?xml version="1.0"?></Envelope>`), ErrProcessingInstruction},
	}
	for _, tc := range cases {
		err := verifier.Verify(tc.data, func(node *Node) error {
			t.Fatalf("%s: handler must not run", tc.name)
			return nil
		})
		if !errors.Is(err, tc.want) {
			t.Fatalf("%s: got %v, want %v", tc.name, err, tc.want)
		}
	}

	// The XML declaration is accepted only when it leads the document.
	leading := []byte(`<?xml version="1.0"?>` +
		`<Envelope xmlns="urn:gsb:xmlmsg:v1"></Envelope>`)
	err := verifier.Verify(leading, func(node *Node) error { return nil })
	if !errors.Is(err, ErrSignatureStructure) {
		t.Fatalf("leading declaration should be tolerated, then fail on structure: %v", err)
	}
}

func TestVerifyAttributeReorderingStaysValid(t *testing.T) {
	fixture := newSignerFixture(t)
	signed := `<Order b="2" a="1" Id="order-8" xmlns="urn:shop"/>`
	delivered := `<Order Id="order-8" a="1" b="2" xmlns="urn:shop"/>`

	digest, signature := fixture.signPayload(signed)
	message := fixture.envelope(delivered + fixture.signatureBlock("order-8", digest, signature))

	verifier, _ := NewVerifier(fixture.public)
	if err := verifier.Verify(message, func(node *Node) error { return nil }); err != nil {
		t.Fatalf("canonicalization must absorb attribute reordering: %v", err)
	}
}

func TestVerifyRejectsUnknownEntity(t *testing.T) {
	fixture := newSignerFixture(t)
	verifier, _ := NewVerifier(fixture.public)
	message := []byte(`<Envelope xmlns="urn:gsb:xmlmsg:v1">&xxe;</Envelope>`)
	err := verifier.Verify(message, func(node *Node) error {
		t.Fatal("handler must not run for unknown entities")
		return nil
	})
	if err == nil {
		t.Fatal("unknown entity must be rejected at parse time")
	}
}

func TestNewVerifierRejectsBadKeySize(t *testing.T) {
	if _, err := NewVerifier(ed25519.PublicKey{1, 2, 3}); err == nil {
		t.Fatal("expected key size error")
	}
}

func TestVerifyRejectsMalformedSignature(t *testing.T) {
	fixture := newSignerFixture(t)
	payload := `<Order Id="order-9" xmlns="urn:shop"><Item>tea</Item></Order>`
	digest, signature := fixture.signPayload(payload)

	cases := map[string]string{
		"unexpected element": `<Signature><Reference URI="#order-9"><DigestValue>` + digest +
			`</DigestValue></Reference><SignatureValue>` + signature + `</SignatureValue><Extra/></Signature>`,
		"missing reference": `<Signature><SignatureValue>` + signature + `</SignatureValue></Signature>`,
		"two references": `<Signature>` +
			`<Reference URI="#order-9"><DigestValue>` + digest + `</DigestValue></Reference>` +
			`<Reference URI="#order-9"><DigestValue>` + digest + `</DigestValue></Reference>` +
			`<SignatureValue>` + signature + `</SignatureValue></Signature>`,
		"bad uri": `<Signature><Reference URI="order-9"><DigestValue>` + digest +
			`</DigestValue></Reference><SignatureValue>` + signature + `</SignatureValue></Signature>`,
		"reference extra attr": `<Signature><Reference URI="#order-9" Index="1"><DigestValue>` +
			digest + `</DigestValue></Reference><SignatureValue>` + signature + `</SignatureValue></Signature>`,
		"short digest": `<Signature><Reference URI="#order-9"><DigestValue>` +
			base64.StdEncoding.EncodeToString([]byte{1, 2, 3}) +
			`</DigestValue></Reference><SignatureValue>` + signature + `</SignatureValue></Signature>`,
		"bad base64": `<Signature><Reference URI="#order-9"><DigestValue>not-base64!</DigestValue>` +
			`</Reference><SignatureValue>` + signature + `</SignatureValue></Signature>`,
		"non-whitespace text": `<Signature>nope<Reference URI="#order-9"><DigestValue>` + digest +
			`</DigestValue></Reference><SignatureValue>` + signature + `</SignatureValue></Signature>`,
	}

	verifier, _ := NewVerifier(fixture.public)
	for name, block := range cases {
		message := fixture.envelope(payload + block)
		err := verifier.Verify(message, func(node *Node) error {
			t.Fatalf("%s: handler must not run", name)
			return nil
		})
		if !errors.Is(err, ErrSignatureStructure) && !errors.Is(err, ErrReference) {
			t.Fatalf("%s: got %v, want ErrSignatureStructure or ErrReference", name, err)
		}
	}
}

func TestVerifyToleratesWhitespaceBetweenElements(t *testing.T) {
	fixture := newSignerFixture(t)
	payload := `<Order Id="order-10" xmlns="urn:shop"><Item>tea</Item></Order>`
	digest, signature := fixture.signPayload(payload)
	message := []byte(`<Envelope xmlns="urn:gsb:xmlmsg:v1">
		` + payload + `
		<Signature>
			<Reference URI="#order-10">
				<DigestValue>` + digest + `</DigestValue>
			</Reference>
			<SignatureValue>` + signature + `</SignatureValue>
		</Signature>
	</Envelope>`)

	verifier, _ := NewVerifier(fixture.public)
	gotPayload := false
	if err := verifier.Verify(message, func(node *Node) error {
		gotPayload = true
		return nil
	}); err != nil {
		t.Fatalf("inter-element whitespace must be tolerated: %v", err)
	}
	if !gotPayload {
		t.Fatal("handler was not invoked")
	}
}

func TestVerifyRejectsNonWhitespaceEnvelopeText(t *testing.T) {
	fixture := newSignerFixture(t)
	payload := `<Order Id="order-11" xmlns="urn:shop"><Item>tea</Item></Order>`
	digest, signature := fixture.signPayload(payload)
	message := fixture.envelope(payload + `stray text` +
		fixture.signatureBlock("order-11", digest, signature))

	verifier, _ := NewVerifier(fixture.public)
	err := verifier.Verify(message, func(node *Node) error {
		t.Fatal("handler must not run with stray envelope text")
		return nil
	})
	if !errors.Is(err, ErrPayloadStructure) {
		t.Fatalf("got %v, want ErrPayloadStructure", err)
	}
}

func TestParseRejectsMalformedDocuments(t *testing.T) {
	cases := map[string][]byte{
		"empty":          nil,
		"two roots":      []byte(`<a/><b/>`),
		"text outside":   []byte(`text<a/>`),
		"unclosed":       []byte(`<a><b></a>`),
		"duplicate attr": []byte(`<a x="1" x="2"/>`),
	}
	for name, data := range cases {
		if _, err := Parse(data); err == nil {
			t.Fatalf("%s: expected parse error", name)
		}
	}
}

func mustDigest(t *testing.T, payloadXML string) []byte {
	t.Helper()
	root, err := Parse([]byte(payloadXML))
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	sum := sha256.Sum256(Canonical(root))
	return sum[:]
}
