package q213

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
)

// EnvelopeNamespace is the namespace of the Signature element and of its
// Reference, DigestValue and SignatureValue children.
const EnvelopeNamespace = "urn:gsb:xmlmsg:v1"

// IDLocal is the unprefixed attribute carrying the referenced identifier.
const IDLocal = "Id"

var (
	// ErrDuplicateID means an unprefixed Id value occurs on more than one
	// element anywhere in the document.
	ErrDuplicateID = errors.New("q213: duplicate element Id")
	// ErrSignatureStructure means the envelope does not contain exactly one
	// well-formed Signature in the expected place.
	ErrSignatureStructure = errors.New("q213: invalid Signature structure")
	// ErrPayloadStructure means the envelope does not contain exactly one
	// business Payload element next to the Signature.
	ErrPayloadStructure = errors.New("q213: invalid Payload structure")
	// ErrReference means the Reference URI is missing, malformed, does not
	// resolve, or does not point at the single business Payload.
	ErrReference = errors.New("q213: invalid Signature Reference")
	// ErrDigest means the SHA-256 digest does not match the canonical Payload.
	ErrDigest = errors.New("q213: digest mismatch")
	// ErrSignature means the Ed25519 signature over the digest is invalid.
	ErrSignature = errors.New("q213: signature verification failed")
)

// Handler consumes exactly the one referenced Payload node after the
// signature has been verified. The verifier never exposes any other node.
type Handler func(payload *Node) error

// Verifier embeds into a Go service and verifies signed XML messages with a
// single injected Ed25519 public key. A Verifier is safe for concurrent use.
type Verifier struct {
	publicKey ed25519.PublicKey
}

// NewVerifier builds a Verifier from an Ed25519 public key. The key must be
// exactly ed25519.PublicKeySize bytes.
func NewVerifier(publicKey ed25519.PublicKey) (*Verifier, error) {
	if len(publicKey) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("q213: Ed25519 public key must be %d bytes, got %d",
			ed25519.PublicKeySize, len(publicKey))
	}
	key := make(ed25519.PublicKey, ed25519.PublicKeySize)
	copy(key, publicKey)
	return &Verifier{publicKey: key}, nil
}

// Verify enforces the full acceptance pipeline:
//
//  1. parse the restricted XML subset (no DTD, comments or processing
//     instructions, leading XML declaration excepted);
//  2. require every unprefixed Id in the whole tree to be unique;
//  3. require exactly one Signature, located outside the single Payload;
//  4. require the single Reference (#ID) to resolve to that same Payload;
//  5. canonicalize the Payload and compare its 32-byte SHA-256 digest;
//  6. verify the Ed25519 signature over that digest;
//  7. hand the referenced Payload node, and only that node, to handler.
func (v *Verifier) Verify(message []byte, handler Handler) error {
	if len(v.publicKey) != ed25519.PublicKeySize {
		return ErrSignature
	}

	root, err := Parse(message)
	if err != nil {
		return err
	}

	ids, err := indexIDs(root)
	if err != nil {
		return err
	}

	signature, payload, err := splitEnvelope(root)
	if err != nil {
		return err
	}

	reference, digestValue, signatureValue, err := parseSignature(signature)
	if err != nil {
		return err
	}

	target, ok := ids[reference]
	if !ok {
		return fmt.Errorf("%w: #%s does not resolve", ErrReference, reference)
	}
	if target != payload {
		// Signature wrapping: the signed element is not the element the
		// envelope would otherwise deliver to the handler.
		return fmt.Errorf("%w: reference does not identify the Payload", ErrReference)
	}

	sum := sha256.Sum256(Canonical(payload))
	if !equalBytes(sum[:], digestValue) {
		return ErrDigest
	}

	if !ed25519.Verify(v.publicKey, sum[:], signatureValue) {
		return ErrSignature
	}

	return handler(payload)
}

type idIndex map[string]*Node

func indexIDs(root *Node) (idIndex, error) {
	ids := idIndex{}
	var walk func(node *Node) error
	walk = func(node *Node) error {
		if !node.IsElement() {
			return nil
		}
		if value, ok := node.Attribute("", IDLocal); ok {
			if _, exists := ids[value]; exists {
				return fmt.Errorf("%w: %q", ErrDuplicateID, value)
			}
			ids[value] = node
		}
		for _, child := range node.Children {
			if err := walk(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return nil, err
	}
	return ids, nil
}

func splitEnvelope(root *Node) (signature *Node, payload *Node, err error) {
	var payloads []*Node
	var signatures []*Node
	for _, child := range root.Children {
		if !child.IsElement() {
			if !isWhitespace(child.Text) {
				return nil, nil, fmt.Errorf("%w: non-whitespace text in envelope", ErrPayloadStructure)
			}
			continue
		}
		if child.Namespace == EnvelopeNamespace && child.Local == "Signature" {
			signatures = append(signatures, child)
			continue
		}
		payloads = append(payloads, child)
	}
	if len(signatures) != 1 {
		return nil, nil, fmt.Errorf("%w: expected exactly one Signature, found %d",
			ErrSignatureStructure, len(signatures))
	}
	if len(payloads) != 1 {
		return nil, nil, fmt.Errorf("%w: expected exactly one Payload element, found %d",
			ErrPayloadStructure, len(payloads))
	}
	if containsNode(payloads[0], signatures[0]) {
		return nil, nil, fmt.Errorf("%w: Signature must not be inside the Payload", ErrSignatureStructure)
	}
	return signatures[0], payloads[0], nil
}

func parseSignature(signature *Node) (reference string, digestValue, signatureValue []byte, err error) {
	var refs []*Node
	var values []*Node
	for _, child := range signature.Children {
		if !child.IsElement() {
			if !isWhitespace(child.Text) {
				return "", nil, nil, fmt.Errorf("%w: non-whitespace text in Signature", ErrSignatureStructure)
			}
			continue
		}
		if child.Namespace != EnvelopeNamespace {
			return "", nil, nil, fmt.Errorf("%w: unexpected element in Signature", ErrSignatureStructure)
		}
		switch child.Local {
		case "Reference":
			refs = append(refs, child)
		case "SignatureValue":
			values = append(values, child)
		default:
			return "", nil, nil, fmt.Errorf("%w: unexpected element %s in Signature",
				ErrSignatureStructure, child.Local)
		}
	}

	if len(refs) != 1 || len(values) != 1 {
		return "", nil, nil, fmt.Errorf("%w: need one Reference and one SignatureValue", ErrSignatureStructure)
	}

	referenceNode := refs[0]
	if len(referenceNode.Attrs) != 1 {
		return "", nil, nil, fmt.Errorf("%w: Reference must carry only its URI", ErrReference)
	}
	uri, ok := referenceNode.Attribute("", "URI")
	if !ok || len(uri) < 2 || uri[0] != '#' {
		return "", nil, nil, fmt.Errorf("%w: Reference URI must be a fragment", ErrReference)
	}

	var digests []*Node
	for _, child := range referenceNode.Children {
		if !child.IsElement() {
			if !isWhitespace(child.Text) {
				return "", nil, nil, fmt.Errorf("%w: non-whitespace text in Reference", ErrReference)
			}
			continue
		}
		if child.Namespace != EnvelopeNamespace || child.Local != "DigestValue" {
			return "", nil, nil, fmt.Errorf("%w: Reference may only contain DigestValue", ErrReference)
		}
		digests = append(digests, child)
	}
	if len(digests) != 1 {
		return "", nil, nil, fmt.Errorf("%w: Reference must contain one DigestValue", ErrReference)
	}

	digestValue, err = decodeBase64(digests[0], sha256.Size)
	if err != nil {
		return "", nil, nil, err
	}
	signatureValue, err = decodeBase64(values[0], ed25519.SignatureSize)
	if err != nil {
		return "", nil, nil, err
	}

	return uri[1:], digestValue, signatureValue, nil
}

func decodeBase64(node *Node, size int) ([]byte, error) {
	if len(node.Attrs) != 0 {
		return nil, fmt.Errorf("%w: %s must not carry attributes", ErrSignatureStructure, node.Local)
	}
	raw := node.TextContent()
	value, err := base64.StdEncoding.DecodeString(raw)
	if err != nil {
		return nil, fmt.Errorf("%w: %s is not base64: %v", ErrSignatureStructure, node.Local, err)
	}
	if len(value) != size {
		return nil, fmt.Errorf("%w: %s must decode to %d bytes, got %d",
			ErrSignatureStructure, node.Local, size, len(value))
	}
	return value, nil
}

func containsNode(ancestor, candidate *Node) bool {
	if ancestor == candidate {
		return true
	}
	for _, child := range ancestor.Children {
		if child.IsElement() && containsNode(child, candidate) {
			return true
		}
	}
	return false
}

func isWhitespace(value string) bool {
	for _, r := range value {
		switch r {
		case ' ', '\t', '\n', '\r':
		default:
			return false
		}
	}
	return true
}

func equalBytes(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
