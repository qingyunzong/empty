package jsoncanon

// Span is a half-open byte range [Start, End) into the source input.
type Span struct {
	Start int `json:"start"`
	End   int `json:"end"`
}

// Kind identifies the JSON value kind.
type Kind int

const (
	KindNull Kind = iota
	KindBool
	KindNumber
	KindString
	KindArray
	KindObject
)

// Member is a single key/value pair of an object.
type Member struct {
	Key     string
	KeySpan Span
	Value   *Value
}

// Value is a parsed JSON node. Numbers keep their exact source literal so
// no decimal precision is ever lost.
type Value struct {
	Kind Kind
	Span Span
	Bool bool
	Num  string // exact decimal literal as written in the source
	Str  string
	Arr  []*Value
	Obj  []Member
}
