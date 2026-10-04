package cfg

import (
	"fmt"
	"sort"
	"strings"
)

// FieldDef records one definition of a field in the inheritance chain.
type FieldDef struct {
	Section string
	Raw     string
}

// InterpNode is one reference used while expanding a field, with the
// references it in turn pulled in.
type InterpNode struct {
	Ref      Ref
	Value    string // final expanded value of the referenced field
	Origin   string // section whose definition won for the referenced field
	Children []*InterpNode
}

// Trace is the full provenance of one final field value.
type Trace struct {
	Ref   Ref
	Value string
	// Chain lists every definition of the field along the inheritance
	// chain, lowest precedence first; the last entry is the winner.
	Chain []FieldDef
	// Interp is the forest of references expanded to produce Value.
	Interp []*InterpNode
}

// TraceField explains where the final value of section/field comes from:
// which definitions competed along the inheritance chain, which one won,
// and which references were expanded (recursively) to produce the value.
// The config must already be resolved with Resolve.
func (c *Config) TraceField(section, field string) (*Trace, error) {
	sec, ok := c.Sections[section]
	if !ok {
		return nil, &MissingError{Msg: fmt.Sprintf("missing section %q", section)}
	}
	value, ok := sec.Values[field]
	if !ok {
		return nil, &MissingError{Msg: fmt.Sprintf("missing field %q in section %q", field, section)}
	}
	tr := &Trace{Ref: Ref{Section: section, Field: field}, Value: value}
	tr.Chain = c.chainOf(section, field, map[string][]FieldDef{})
	seen := map[Ref]bool{}
	var build func(r Ref) *InterpNode
	build = func(r Ref) *InterpNode {
		s := c.Sections[r.Section]
		n := &InterpNode{Ref: r, Value: s.Values[r.Field], Origin: s.Origin[r.Field]}
		if seen[r] {
			return n
		}
		seen[r] = true
		for _, sub := range s.Refs[r.Field] {
			n.Children = append(n.Children, build(sub))
		}
		return n
	}
	for _, r := range sec.Refs[field] {
		tr.Interp = append(tr.Interp, build(r))
	}
	return tr, nil
}

// chainOf returns every definition of field visible from section, in
// override order (lowest precedence first, winner last). It replays the
// merge: a parent's chain is spliced in listed order, and a re-defined
// section moves to the end, so diamonds collapse to one entry per
// section and the last entry is exactly the winning Origin.
func (c *Config) chainOf(section, field string, memo map[string][]FieldDef) []FieldDef {
	if ch, ok := memo[section]; ok {
		return ch
	}
	var chain []FieldDef
	appendDef := func(d FieldDef) {
		for i, e := range chain {
			if e.Section == d.Section {
				chain = append(chain[:i], chain[i+1:]...)
				break
			}
		}
		chain = append(chain, d)
	}
	raw := c.raw[section]
	for _, p := range raw.Parents {
		for _, d := range c.chainOf(p, field, memo) {
			appendDef(d)
		}
	}
	if v, ok := raw.Own[field]; ok {
		appendDef(FieldDef{Section: section, Raw: v})
	}
	memo[section] = chain
	return chain
}

// String renders the trace in a human-readable form.
func (t *Trace) String() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s = %s\n", t.Ref, t.Value)
	if len(t.Chain) > 0 {
		b.WriteString("definitions (lowest precedence first, * = winner):\n")
		for i, d := range t.Chain {
			mark := "  "
			if i == len(t.Chain)-1 {
				mark = "* "
			}
			fmt.Fprintf(&b, "  %s[%s] %s = %s\n", mark, d.Section, t.Ref.Field, d.Raw)
		}
	}
	if len(t.Interp) > 0 {
		b.WriteString("interpolation sources:\n")
		for _, n := range t.Interp {
			writeInterpNode(&b, n, "  ")
		}
	}
	return b.String()
}

func writeInterpNode(b *strings.Builder, n *InterpNode, indent string) {
	fmt.Fprintf(b, "%s%s = %s (defined in [%s])\n", indent, n.Ref, n.Value, n.Origin)
	for _, ch := range n.Children {
		writeInterpNode(b, ch, indent+"  ")
	}
}

// SortedFields returns field names of a section in deterministic order.
func SortedFields(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
