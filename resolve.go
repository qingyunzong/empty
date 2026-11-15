package dataeng

import (
	"errors"
	"fmt"
	"strings"
)

// Action describes what a decoder must do at one plan node.
type Action string

const (
	// ActionMatch: writer and reader types agree.
	ActionMatch Action = "match"
	// ActionPromote: writer primitive is promoted to the reader primitive.
	ActionPromote Action = "promote"
	// ActionDefault: reader field is absent from the writer; use its default.
	ActionDefault Action = "default"
	// ActionSkip: writer field is not read by the reader; skip it.
	ActionSkip Action = "skip"
	// ActionEnumDefault: writer enum symbol may be unknown to the reader;
	// fall back to the reader enum default.
	ActionEnumDefault Action = "enum-default"
)

// PlanNode is one node of a writer-reader resolution plan.
type PlanNode struct {
	Path   string
	Action Action
	// Field is the record field this node belongs to, if any.
	Field string
	// ViaAlias reports the field was matched through a reader field alias.
	ViaAlias bool
	// Recursive marks a back-reference to an already-planned record pair.
	Recursive bool
	Writer    Type
	Reader    Type
	// Fields holds record children: reader fields in reader order, then
	// skipped writer fields.
	Fields []*PlanNode
	// Item is the array element plan.
	Item *PlanNode
	// Value is the map value plan.
	Value *PlanNode
	// Branches holds one plan per writer union branch.
	Branches []*PlanNode
	// Branch is the matched reader union branch plan.
	Branch *PlanNode
}

// Plan is a writer-reader resolution plan.
type Plan struct {
	Root *PlanNode
}

func (p *Plan) String() string {
	var sb strings.Builder
	p.Root.writeTo(&sb, 0)
	return sb.String()
}

func (n *PlanNode) writeTo(sb *strings.Builder, depth int) {
	fmt.Fprintf(sb, "%s%s %s", strings.Repeat("  ", depth), n.Action, n.Path)
	if n.ViaAlias {
		sb.WriteString(" (via alias)")
	}
	if n.Recursive {
		sb.WriteString(" (recursive)")
	}
	sb.WriteByte('\n')
	children := make([]*PlanNode, 0, len(n.Fields)+len(n.Branches)+2)
	children = append(children, n.Fields...)
	if n.Item != nil {
		children = append(children, n.Item)
	}
	if n.Value != nil {
		children = append(children, n.Value)
	}
	children = append(children, n.Branches...)
	if n.Branch != nil {
		children = append(children, n.Branch)
	}
	for _, c := range children {
		c.writeTo(sb, depth+1)
	}
}

// IncompatibleError reports the first schema path that cannot be resolved
// from writer to reader.
type IncompatibleError struct {
	Path   string
	Reason string
}

func (e *IncompatibleError) Error() string {
	return fmt.Sprintf("avro: incompatible schemas at %s: %s", e.Path, e.Reason)
}

// IncompatiblePath extracts the first incompatible path from an error
// returned by Resolve.
func IncompatiblePath(err error) (string, bool) {
	var ie *IncompatibleError
	if errors.As(err, &ie) {
		return ie.Path, true
	}
	return "", false
}

// promotions lists the allowed primitive writer -> reader conversions.
var promotions = map[Kind]map[Kind]bool{
	KindInt:    {KindLong: true, KindFloat: true, KindDouble: true},
	KindLong:   {KindFloat: true, KindDouble: true},
	KindFloat:  {KindDouble: true},
	KindString: {KindBytes: true},
	KindBytes:  {KindString: true},
}

// Resolve builds the resolution plan for decoding data written with writer
// using reader. On failure it returns an *IncompatibleError carrying the
// first incompatible path in traversal order.
func Resolve(writer, reader *CompiledSchema) (*Plan, error) {
	if writer == nil || reader == nil {
		return nil, errors.New("avro: Resolve requires non-nil schemas")
	}
	root, err := resolveTypes(writer.Root, reader.Root, "$", make(map[resolvePair]bool))
	if err != nil {
		return nil, err
	}
	return &Plan{Root: root}, nil
}

type resolvePair struct {
	w, r Type
}

func resolveTypes(w, r Type, path string, seen map[resolvePair]bool) (*PlanNode, error) {
	if wu, ok := w.(*Union); ok {
		n := &PlanNode{Path: path, Action: ActionMatch, Writer: w, Reader: r}
		for i, wt := range wu.Types {
			child, err := resolveWriterBranch(wt, r, fmt.Sprintf("%s[%d]", path, i), seen)
			if err != nil {
				return nil, err
			}
			n.Branches = append(n.Branches, child)
		}
		return n, nil
	}
	return resolveWriterBranch(w, r, path, seen)
}

func resolveWriterBranch(w, r Type, path string, seen map[resolvePair]bool) (*PlanNode, error) {
	if ru, ok := r.(*Union); ok {
		for _, rt := range ru.Types {
			if child, err := resolveTypes(w, rt, path, seen); err == nil {
				return &PlanNode{Path: path, Action: ActionMatch, Writer: w, Reader: r, Branch: child}, nil
			}
		}
		return nil, &IncompatibleError{
			Path:   path,
			Reason: fmt.Sprintf("writer %s matches no reader union branch", typeLabel(w)),
		}
	}
	return resolveConcrete(w, r, path, seen)
}

func resolveConcrete(w, r Type, path string, seen map[resolvePair]bool) (*PlanNode, error) {
	switch wt := w.(type) {
	case *Primitive:
		rt, ok := r.(*Primitive)
		if !ok {
			return nil, incompatible(path, w, r)
		}
		if wt.Kind() == rt.Kind() {
			return &PlanNode{Path: path, Action: ActionMatch, Writer: w, Reader: r}, nil
		}
		if promotions[wt.Kind()][rt.Kind()] {
			return &PlanNode{Path: path, Action: ActionPromote, Writer: w, Reader: r}, nil
		}
		return nil, &IncompatibleError{
			Path:   path,
			Reason: fmt.Sprintf("cannot promote writer %s to reader %s", typeLabel(w), typeLabel(r)),
		}
	case *Record:
		rt, ok := r.(*Record)
		if !ok {
			return nil, incompatible(path, w, r)
		}
		return resolveRecord(wt, rt, path, seen)
	case *Enum:
		rt, ok := r.(*Enum)
		if !ok {
			return nil, incompatible(path, w, r)
		}
		return resolveEnum(wt, rt, path)
	case *Array:
		rt, ok := r.(*Array)
		if !ok {
			return nil, incompatible(path, w, r)
		}
		item, err := resolveTypes(wt.Items, rt.Items, path+"[]", seen)
		if err != nil {
			return nil, err
		}
		return &PlanNode{Path: path, Action: ActionMatch, Writer: w, Reader: r, Item: item}, nil
	case *Map:
		rt, ok := r.(*Map)
		if !ok {
			return nil, incompatible(path, w, r)
		}
		value, err := resolveTypes(wt.Values, rt.Values, path+"{}", seen)
		if err != nil {
			return nil, err
		}
		return &PlanNode{Path: path, Action: ActionMatch, Writer: w, Reader: r, Value: value}, nil
	case *Fixed:
		rt, ok := r.(*Fixed)
		if !ok {
			return nil, incompatible(path, w, r)
		}
		if !namedMatches(wt, rt) {
			return nil, &IncompatibleError{
				Path:   path,
				Reason: fmt.Sprintf("fixed name mismatch: writer %s, reader %s", wt.Name, rt.Name),
			}
		}
		if wt.Size != rt.Size {
			return nil, &IncompatibleError{
				Path:   path,
				Reason: fmt.Sprintf("fixed size mismatch: writer %d, reader %d", wt.Size, rt.Size),
			}
		}
		return &PlanNode{Path: path, Action: ActionMatch, Writer: w, Reader: r}, nil
	}
	return nil, incompatible(path, w, r)
}

func resolveRecord(w, r *Record, path string, seen map[resolvePair]bool) (*PlanNode, error) {
	if !namedMatches(w, r) {
		return nil, &IncompatibleError{
			Path:   path,
			Reason: fmt.Sprintf("record name mismatch: writer %s, reader %s", w.Name, r.Name),
		}
	}
	pair := resolvePair{w, r}
	if seen[pair] {
		return &PlanNode{Path: path, Action: ActionMatch, Writer: w, Reader: r, Recursive: true}, nil
	}
	seen[pair] = true
	defer delete(seen, pair)

	n := &PlanNode{Path: path, Action: ActionMatch, Writer: w, Reader: r}
	consumed := make([]bool, len(w.Fields))
	for _, rf := range r.Fields {
		childPath := path + "." + rf.Name
		idx, viaAlias := findField(w, rf)
		if idx < 0 {
			if !rf.HasDefault {
				return nil, &IncompatibleError{
					Path:   childPath,
					Reason: fmt.Sprintf("reader field %q has no matching writer field and no default", rf.Name),
				}
			}
			n.Fields = append(n.Fields, &PlanNode{
				Path:   childPath,
				Action: ActionDefault,
				Field:  rf.Name,
				Reader: rf.Type,
			})
			continue
		}
		consumed[idx] = true
		child, err := resolveTypes(w.Fields[idx].Type, rf.Type, childPath, seen)
		if err != nil {
			return nil, err
		}
		child.Field = rf.Name
		child.ViaAlias = viaAlias
		n.Fields = append(n.Fields, child)
	}
	for i, wf := range w.Fields {
		if consumed[i] {
			continue
		}
		n.Fields = append(n.Fields, &PlanNode{
			Path:   path + "." + wf.Name,
			Action: ActionSkip,
			Field:  wf.Name,
			Writer: wf.Type,
		})
	}
	return n, nil
}

func resolveEnum(w, r *Enum, path string) (*PlanNode, error) {
	if !namedMatches(w, r) {
		return nil, &IncompatibleError{
			Path:   path,
			Reason: fmt.Sprintf("enum name mismatch: writer %s, reader %s", w.Name, r.Name),
		}
	}
	readerSymbols := make(map[string]bool, len(r.Symbols))
	for _, s := range r.Symbols {
		readerSymbols[s] = true
	}
	var missing []string
	for _, s := range w.Symbols {
		if !readerSymbols[s] {
			missing = append(missing, s)
		}
	}
	if len(missing) > 0 {
		if r.HasDefault {
			return &PlanNode{Path: path, Action: ActionEnumDefault, Writer: w, Reader: r}, nil
		}
		return nil, &IncompatibleError{
			Path:   path,
			Reason: fmt.Sprintf("reader enum %s lacks writer symbols %v and has no default", r.Name, missing),
		}
	}
	return &PlanNode{Path: path, Action: ActionMatch, Writer: w, Reader: r}, nil
}

// findField locates the writer field matching reader field rf, by name or by
// one of the reader field's aliases.
func findField(w *Record, rf *Field) (idx int, viaAlias bool) {
	for i, wf := range w.Fields {
		if wf.Name == rf.Name {
			return i, false
		}
	}
	for _, alias := range rf.Aliases {
		for i, wf := range w.Fields {
			if wf.Name == alias {
				return i, true
			}
		}
	}
	return -1, false
}

// namedMatches reports whether writer named type w matches reader named type
// r, by fullname or through the reader's type aliases.
func namedMatches(w, r Named) bool {
	if w.Fullname() == r.Fullname() {
		return true
	}
	for _, alias := range r.TypeAliases() {
		if alias == w.Fullname() {
			return true
		}
	}
	return false
}

func incompatible(path string, w, r Type) *IncompatibleError {
	return &IncompatibleError{
		Path:   path,
		Reason: fmt.Sprintf("cannot read writer %s as reader %s", typeLabel(w), typeLabel(r)),
	}
}
