package interp

import (
	"fmt"
	"strconv"
	"strings"
)

// Value is a runtime value: nil, bool, int64, string, Symbol, *Pair, *Closure or *Builtin.
type Value = any

// Symbol is a quoted symbol value.
type Symbol string

// Pair is an immutable cons cell.
type Pair struct {
	Car Value
	Cdr Value
}

// Closure is a lexically scoped function value.
type Closure struct {
	Name   string
	Params []string
	Body   []*Node
	Env    *Env
}

// Builtin references a Go function in the builtins registry by name, so values stay serializable.
type Builtin struct {
	Name string
}

// Env is a lexical environment frame.
type Env struct {
	Vars   map[string]Value
	Parent *Env
}

func (e *Env) lookup(name string) (Value, bool) {
	for ; e != nil; e = e.Parent {
		if v, ok := e.Vars[name]; ok {
			return v, true
		}
	}
	return nil, false
}

func (e *Env) assign(name string, v Value) bool {
	for ; e != nil; e = e.Parent {
		if _, ok := e.Vars[name]; ok {
			e.Vars[name] = v
			return true
		}
	}
	return false
}

// NewGlobals returns the global environment populated with builtins.
func NewGlobals() *Env {
	g := &Env{Vars: map[string]Value{}}
	for name := range builtins {
		g.Vars[name] = &Builtin{Name: name}
	}
	return g
}

// Throw is the error used to propagate (throw v) through the reference interpreter.
type Throw struct{ Val Value }

func (t *Throw) Error() string { return "uncaught exception: " + showValue(t.Val) }

// Logger is the sink for the emit builtin; both interpreters implement it.
type Logger interface{ Log(string) }

func truthy(v Value) bool {
	if b, ok := v.(bool); ok {
		return b
	}
	return true
}

func showValue(v Value) string {
	switch x := v.(type) {
	case nil:
		return "nil"
	case bool:
		if x {
			return "true"
		}
		return "false"
	case int64:
		return strconv.FormatInt(x, 10)
	case string:
		return x
	case Symbol:
		return string(x)
	case *Builtin:
		return "<builtin " + x.Name + ">"
	case *Closure:
		if x.Name != "" {
			return "<closure " + x.Name + ">"
		}
		return "<closure>"
	case *Pair:
		var sb strings.Builder
		sb.WriteByte('(')
		cur := v
		first := true
		for {
			p := cur.(*Pair)
			if !first {
				sb.WriteByte(' ')
			}
			first = false
			sb.WriteString(showValue(p.Car))
			switch rest := p.Cdr.(type) {
			case nil:
				sb.WriteByte(')')
				return sb.String()
			case *Pair:
				cur = rest
			default:
				sb.WriteString(" . ")
				sb.WriteString(showValue(rest))
				sb.WriteByte(')')
				return sb.String()
			}
		}
	}
	return fmt.Sprintf("?%T", v)
}

func valuesEqual(a, b Value) bool {
	switch x := a.(type) {
	case nil:
		return b == nil
	case int64:
		y, ok := b.(int64)
		return ok && x == y
	case string:
		y, ok := b.(string)
		return ok && x == y
	case bool:
		y, ok := b.(bool)
		return ok && x == y
	case Symbol:
		y, ok := b.(Symbol)
		return ok && x == y
	case *Pair:
		y, ok := b.(*Pair)
		return ok && x == y
	case *Closure:
		y, ok := b.(*Closure)
		return ok && x == y
	case *Builtin:
		y, ok := b.(*Builtin)
		return ok && x.Name == y.Name
	}
	return false
}
