package dataeng

import (
	"fmt"
	"strconv"
)

// Kind identifies the symbol class carried by a Token. The classes are
// deliberately disjoint: a Known token is never equal to either kind of
// unknown token, even when its text is empty.
type Kind uint8

const (
	// LocalUnknownKind is the class represented by SID 0. Local unknown
	// symbols have no text and no shared-dictionary identity.
	LocalUnknownKind Kind = iota
	// KnownKind is a symbol whose complete text is available.
	KnownKind
	// SharedUnknownKind is a slot of a shared dictionary whose text is not
	// available. Its identity is (table name, one-based slot position).
	SharedUnknownKind
)

// Additional spellings for the kind constants make the enum convenient in
// callers that prefer explicit prefixes.
const (
	KindLocalUnknown   = LocalUnknownKind
	KindKnown          = KnownKind
	KindSharedUnknown  = SharedUnknownKind
	TokenLocalUnknown  = LocalUnknownKind
	TokenKnown         = KnownKind
	TokenSharedUnknown = SharedUnknownKind
)

// SID is a symbol identifier in a Context. SID 0 is the local unknown
// identity; all slots assigned by a Context start at 1.
type SID = uint64

// Token is an immutable-by-value symbol identity. Only fields relevant to
// Kind are meaningful:
//
//   - LocalUnknownKind: no other fields are used.
//   - KnownKind:        Text holds the complete text.
//   - SharedUnknownKind: Name and Ordinal hold the shared-table identity.
//
// Tokens obtained from Resolve are snapshots. They do not consult a Context
// later, so Reset, dictionary replacement and AppendLocal cannot change a
// token that has already been returned.
type Token struct {
	Kind    Kind
	Text    string
	Name    string
	Ordinal uint64
}

// Known returns a Known token carrying the exact bytes of text. No Unicode
// normalization is performed. An empty text is a valid Known token and is
// distinct from LocalUnknown().
func Known(text string) Token {
	return Token{Kind: KnownKind, Text: text}
}

// LocalUnknown returns the identity represented by SID 0.
func LocalUnknown() Token {
	return Token{Kind: LocalUnknownKind}
}

// SharedUnknown returns an unknown shared-dictionary slot identity. Name is
// the dictionary table name and ordinal is the one-based position in that
// table. Version deliberately does not participate in this identity.
func SharedUnknown(name string, ordinal uint64) Token {
	return Token{Kind: SharedUnknownKind, Name: name, Ordinal: ordinal}
}

// IsKnown reports whether t is a Known token.
func (t Token) IsKnown() bool { return t.Kind == KnownKind }

// IsLocalUnknown reports whether t is a LocalUnknown token.
func (t Token) IsLocalUnknown() bool { return t.Kind == LocalUnknownKind }

// IsSharedUnknown reports whether t is a SharedUnknown token.
func (t Token) IsSharedUnknown() bool { return t.Kind == SharedUnknownKind }

// Equivalent reports whether a and b denote the same symbol identity.
//
// Known tokens compare their complete UTF-8 text byte for byte. Shared
// unknown tokens compare their table name and one-based ordinal, ignoring
// dictionary version. LocalUnknown tokens are all equal. Values from
// different classes are never equivalent.
func Equivalent(a, b Token) bool {
	if a.Kind != b.Kind {
		return false
	}
	switch a.Kind {
	case KnownKind:
		return a.Text == b.Text
	case LocalUnknownKind:
		return true
	case SharedUnknownKind:
		return a.Name == b.Name && a.Ordinal == b.Ordinal
	default:
		// Unknown kinds are not symbols and are never equivalent.
		return false
	}
}

// Equal is the method form of Equivalent.
func (t Token) Equal(other Token) bool { return Equivalent(t, other) }

func (t Token) String() string {
	switch t.Kind {
	case KnownKind:
		return "Known(" + strconv.Quote(t.Text) + ")"
	case LocalUnknownKind:
		return "LocalUnknown"
	case SharedUnknownKind:
		return "SharedUnknown(" + strconv.Quote(t.Name) + ", " +
			strconv.FormatUint(t.Ordinal, 10) + ")"
	default:
		return fmt.Sprintf("Token(kind=%d)", t.Kind)
	}
}
