package dataeng

// Kind identifies the four kinds of AST nodes accepted by the compiler.
type Kind string

const (
	// Group contains children laid out consecutively with no implicit padding.
	Group Kind = "group"
	// UnsignedDisplay is an unsigned zoned/display decimal. Every digit is one
	// ASCII byte and the value is always non-negative.
	UnsignedDisplay Kind = "unsigned-display"
	// SignedPacked is a signed packed-decimal. The scale is supplied by the
	// copybook and is applied without floating point arithmetic.
	SignedPacked Kind = "signed-packed"
	// RawBytes is a fixed-length opaque byte field. A zero length is valid.
	RawBytes Kind = "raw-bytes"
)

// AST is a parsed copybook subset. Root is normally a Group. Overlays describes
// the adjacent root-level REDEFINES groups referenced by Node.Overlay.
type AST struct {
	Root     *Node
	Overlays []Overlay
}

// Node is one copybook layout node.
//
// Path is the unique, host-supplied field path used in results and errors.
// Digits is the number of decimal digits for UnsignedDisplay and SignedPacked.
// Scale is the fractional scale for SignedPacked. Bytes is the physical byte
// length for RawBytes. Children is used only by Group. Occurs is nil for a
// field that occurs exactly once. Overlay is non-empty only on root-level
// branch roots that participate in a REDEFINES group.
type Node struct {
	Path     string
	Kind     Kind
	Digits   int
	Scale    int
	Bytes    int
	Children []*Node
	Occurs   *Occurs
	Overlay  string
}

// Occurs describes repetition. A nil DependingOn means a fixed OCCURS of Max
// copies (Max must be positive). A non-nil DependingOn means a variable OCCURS
// from zero through Max copies, controlled by that root-level unsigned scalar.
type Occurs struct {
	Max         int
	DependingOn string
}

// Fixed returns a fixed OCCURS with count copies. The compiler rejects count
// values that are not positive.
func Fixed(count int) *Occurs {
	return &Occurs{Max: count}
}

// UpTo returns a variable OCCURS from zero through max copies, depending on
// controlPath.
func UpTo(max int, controlPath string) *Occurs {
	return &Occurs{Max: max, DependingOn: controlPath}
}

// Overlay describes a REDEFINES group. Name matches Node.Overlay on the branch
// root nodes. Control is the unique path of a preceding root-level, non-
// repeating unsigned display scalar. Branches maps the control value to the
// chosen branch root path. Values missing from the map are rejected at decode
// time.
type Overlay struct {
	Name     string
	Control  string
	Branches map[uint64]string
}
