package layout

import (
	"fmt"
	"math/bits"
)

// Layout is the computed placement of a Type. For structs, Fields
// mirrors the declaration order with absolute offsets relative to
// the struct start.
type Layout struct {
	Size   uint64
	Align  uint64
	Fields []FieldLayout
}

// FieldLayout is the placement of one struct field.
type FieldLayout struct {
	Name   string
	Offset uint64
	Layout *Layout
}

// LeafRange is the absolute byte range of one leaf (Int) slot,
// identified by a dotted path such as "point.coords[2].x".
type LeafRange struct {
	Path   string
	Offset uint64
	Size   uint64
}

// alignUp rounds n up to the next multiple of align. align must be a
// non-zero power of two; the caller guarantees n+align-1 cannot
// overflow because all sizes are checked before alignment.
func alignUp(n, align uint64) uint64 {
	return (n + align - 1) &^ (align - 1)
}

// Compute lays out t, resolving Ref types through env. On recursive
// value types it returns a *CycleError naming the full chain; on
// arithmetic overflow it returns an *OverflowError and no layout.
func Compute(t Type, env Env) (*Layout, error) {
	return compute(t, env, nil)
}

// compute is the recursive worker; stack holds the names of Ref types
// currently being expanded, for cycle detection.
func compute(t Type, env Env, stack []string) (*Layout, error) {
	switch t.Kind {
	case Int:
		if t.Size == 0 || t.Size&(t.Size-1) != 0 {
			return nil, fmt.Errorf("int size %d is not a non-zero power of two", t.Size)
		}
		return &Layout{Size: t.Size, Align: t.Size}, nil

	case Ref:
		for i, name := range stack {
			if name == t.Name {
				return nil, &CycleError{Chain: append(append([]string{}, stack[i:]...), t.Name)}
			}
		}
		def, ok := env[t.Name]
		if !ok {
			return nil, fmt.Errorf("unknown type %q", t.Name)
		}
		return compute(def, env, append(stack, t.Name))

	case Array:
		if t.Elem == nil {
			return nil, fmt.Errorf("array with nil element type")
		}
		elem, err := compute(*t.Elem, env, stack)
		if err != nil {
			return nil, err
		}
		hi, lo := bits.Mul64(elem.Size, t.Count)
		if hi != 0 {
			return nil, &OverflowError{What: fmt.Sprintf("array of %d x %d bytes", t.Count, elem.Size)}
		}
		return &Layout{Size: lo, Align: elem.Align}, nil

	case Struct:
		out := &Layout{Align: 1}
		offset := uint64(0)
		for _, f := range t.Fields {
			fl, err := compute(f.Type, env, stack)
			if err != nil {
				return nil, err
			}
			if fl.Align > out.Align {
				out.Align = fl.Align
			}
			aligned := alignUp(offset, fl.Align)
			if aligned < offset {
				return nil, &OverflowError{What: fmt.Sprintf("offset of field %q", f.Name)}
			}
			end, carry := bits.Add64(aligned, fl.Size, 0)
			if carry != 0 {
				return nil, &OverflowError{What: fmt.Sprintf("end of field %q", f.Name)}
			}
			out.Fields = append(out.Fields, FieldLayout{Name: f.Name, Offset: aligned, Layout: fl})
			offset = end
		}
		size := alignUp(offset, out.Align)
		if size < offset {
			return nil, &OverflowError{What: "struct tail padding"}
		}
		out.Size = size
		return out, nil

	default:
		return nil, fmt.Errorf("unknown type kind %d", t.Kind)
	}
}

// Leaves flattens l into the absolute byte ranges of every leaf Int
// slot, using base as the offset of l itself and prefix as the path
// of l itself. Array elements are indexed as name[i].
func (l *Layout) Leaves(t Type, env Env, base uint64, prefix string) ([]LeafRange, error) {
	switch t.Kind {
	case Int:
		return []LeafRange{{Path: prefix, Offset: base, Size: l.Size}}, nil
	case Ref:
		def, ok := env[t.Name]
		if !ok {
			return nil, fmt.Errorf("unknown type %q", t.Name)
		}
		return l.Leaves(def, env, base, prefix)
	case Array:
		var out []LeafRange
		elem, err := Compute(*t.Elem, env)
		if err != nil {
			return nil, err
		}
		for i := uint64(0); i < t.Count; i++ {
			sub, err := elem.Leaves(*t.Elem, env, base+i*elem.Size, fmt.Sprintf("%s[%d]", prefix, i))
			if err != nil {
				return nil, err
			}
			out = append(out, sub...)
		}
		return out, nil
	case Struct:
		var out []LeafRange
		for i, f := range t.Fields {
			sub, err := l.Fields[i].Layout.Leaves(f.Type, env, base+l.Fields[i].Offset, prefix+"."+f.Name)
			if err != nil {
				return nil, err
			}
			out = append(out, sub...)
		}
		return out, nil
	default:
		return nil, fmt.Errorf("unknown type kind %d", t.Kind)
	}
}
