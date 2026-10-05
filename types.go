package main

// Kind classifies nodes in the interface type graph.
type Kind int

const (
	kindUnset Kind = iota // placeholder left by a cyclic alias such as "type A = A"
	KindAny
	KindPrim
	KindFunc
	KindInterface
)

// Type is a node in a (possibly cyclic) interface type graph.
// Named references are resolved to shared pointers at parse time,
// so recursion is represented by cycles in the graph.
type Type struct {
	Kind     Kind
	Name     string   // primitive name, when Kind == KindPrim
	Params   []*Type  // function parameter types, when Kind == KindFunc
	Result   *Type    // function result type, when Kind == KindFunc
	Members  []Member // interface members, when Kind == KindInterface
	TypeName string   // declared name, if this node came from a "type" declaration
}

// Member is a single named member of an interface. Methods are desugared
// into members whose type is a KindFunc node.
type Member struct {
	Name string
	Type *Type
}

// Lookup returns the member type with the given name, or nil.
func (t *Type) Lookup(name string) *Type {
	for _, m := range t.Members {
		if m.Name == name {
			return m.Type
		}
	}
	return nil
}

func kindString(k Kind) string {
	switch k {
	case KindAny:
		return "any"
	case KindPrim:
		return "primitive"
	case KindFunc:
		return "func"
	case KindInterface:
		return "interface"
	}
	return "undefined"
}

// describe gives a short human-readable label for error messages.
func describe(t *Type) string {
	if t.Kind == KindPrim {
		return "primitive " + t.Name
	}
	s := kindString(t.Kind)
	if t.TypeName != "" {
		s += " " + t.TypeName
	}
	return s
}
