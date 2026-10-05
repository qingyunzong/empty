package macro

import (
	"fmt"
	"strings"
)

// BudgetError is returned when the expansion step budget runs out
// before expansion closes. Chain holds the macros being expanded.
type BudgetError struct{ Chain []Symbol }

func (e *BudgetError) Error() string {
	return fmt.Sprintf("macro expansion budget exhausted (unclosed): call chain %s", FormatChain(e.Chain))
}

// RecursionError is returned when a macro expands to a call of a macro
// already on the expansion stack. Chain ends with the repeated macro.
type RecursionError struct{ Chain []Symbol }

func (e *RecursionError) Error() string {
	return fmt.Sprintf("recursive macro expansion: call chain %s", FormatChain(e.Chain))
}

func FormatChain(chain []Symbol) string {
	parts := make([]string, len(chain))
	for i, c := range chain {
		parts[i] = string(c)
	}
	if len(parts) == 0 {
		return "(empty)"
	}
	return strings.Join(parts, " -> ")
}

// Injected marks a caller-supplied value that a macro splices into
// its template (an argument that evaluated to a symbol or a list
// containing symbols). Hygienic renaming never touches injected
// symbols, so macro-introduced temporaries cannot capture them.
type Injected struct{ V Value }

func inject(v Value) Value {
	switch t := v.(type) {
	case Symbol:
		return Injected{t}
	case List:
		out := make(List, len(t))
		for i, e := range t {
			out[i] = inject(e)
		}
		return out
	default:
		return v
	}
}

// Expander expands macro calls. Budget is the number of expansion steps
// still allowed; StepsUsed counts consumed steps. Expansion of a macro
// call evaluates the arguments in the caller environment first, binds
// them to the parameters in a frame over the macro's definition
// environment (lexical scope), evaluates the body there to obtain a
// template, then expands the template in the caller environment with
// hygienic renaming of template-local let bindings.
type Expander struct {
	Budget    int
	StepsUsed int
	chain     []Symbol
	gensym    int
}

func NewExpander(budget int) *Expander { return &Expander{Budget: budget} }

func (x *Expander) step() error {
	if x.Budget <= 0 {
		return &BudgetError{Chain: append([]Symbol(nil), x.chain...)}
	}
	x.Budget--
	x.StepsUsed++
	return nil
}

func (x *Expander) fresh(s Symbol) Symbol {
	x.gensym++
	return Symbol(fmt.Sprintf("%s__%d", s, x.gensym))
}

// Expand expands expr in env (caller code, no hygienic renaming).
func (x *Expander) Expand(env *Env, expr Value) (Value, error) {
	return x.expand(env, expr, false)
}

func (x *Expander) expand(env *Env, expr Value, hygienic bool) (Value, error) {
	if inj, ok := expr.(Injected); ok {
		// Caller data spliced into a template: expand as caller code,
		// never renamed by template hygiene.
		return x.expand(env, inj.V, false)
	}
	if err := x.step(); err != nil {
		return nil, err
	}
	list, ok := expr.(List)
	if !ok || len(list) == 0 {
		return expr, nil
	}
	if head, ok := list[0].(Symbol); ok {
		switch head {
		case "quote", "defmacro":
			return expr, nil
		case "let":
			return x.expandLet(env, list, hygienic)
		}
		if v, ok := env.Lookup(head); ok {
			if m, isMacro := v.(*Macro); isMacro {
				return x.expandMacro(env, m, list[1:])
			}
		}
	}
	out := make(List, len(list))
	out[0] = list[0]
	for i := 1; i < len(list); i++ {
		r, err := x.expand(env, list[i], hygienic)
		if err != nil {
			return nil, err
		}
		out[i] = r
	}
	return out, nil
}

func (x *Expander) expandMacro(callEnv *Env, m *Macro, args List) (Value, error) {
	if err := x.step(); err != nil {
		return nil, err
	}
	for _, c := range x.chain {
		if c == m.Name {
			chain := append(append([]Symbol(nil), x.chain...), m.Name)
			return nil, &RecursionError{Chain: chain}
		}
	}
	if len(args) != len(m.Params) {
		return nil, fmt.Errorf("macro %s: expected %d args, got %d", m.Name, len(m.Params), len(args))
	}
	// Arguments are evaluated in the caller environment first.
	values := make([]Value, len(args))
	for i, a := range args {
		ax, err := x.expand(callEnv, a, false)
		if err != nil {
			return nil, err
		}
		v, err := Eval(callEnv, ax)
		if err != nil {
			return nil, fmt.Errorf("macro %s: argument %d: %w", m.Name, i+1, err)
		}
		values[i] = inject(v)
	}
	// Parameters are bound in a frame over the definition environment.
	menv := NewEnv(m.DefEnv)
	for i, p := range m.Params {
		menv.Define(p, values[i])
	}
	x.chain = append(x.chain, m.Name)
	defer func() { x.chain = x.chain[:len(x.chain)-1] }()
	bodyEx, err := x.expand(menv, m.Body, false)
	if err != nil {
		return nil, err
	}
	template, err := Eval(menv, bodyEx)
	if err != nil {
		return nil, fmt.Errorf("macro %s: %w", m.Name, err)
	}
	// The template is caller-side code: expand it hygienically so
	// macro-introduced locals cannot capture caller variables.
	return x.expand(callEnv, template, true)
}

// expandLet expands a let form. In hygienic mode every bound variable
// is renamed to a fresh symbol and consistently substituted in the body.
func (x *Expander) expandLet(env *Env, form List, hygienic bool) (Value, error) {
	if len(form) < 3 {
		return nil, fmt.Errorf("let: expected (let ((v e) ...) body ...)")
	}
	binds, ok := form[1].(List)
	if !ok {
		return nil, fmt.Errorf("let: malformed bindings")
	}
	renames := map[Symbol]Symbol{}
	newBinds := make(List, 0, len(binds))
	for _, b := range binds {
		pair, ok := b.(List)
		if !ok || len(pair) != 2 {
			return nil, fmt.Errorf("let: malformed binding %v", b)
		}
		name, ok := pair[0].(Symbol)
		if !ok {
			return nil, fmt.Errorf("let: binding name must be a symbol")
		}
		init, err := x.expand(env, pair[1], hygienic)
		if err != nil {
			return nil, err
		}
		if hygienic {
			fresh := x.fresh(name)
			renames[name] = fresh
			name = fresh
		}
		newBinds = append(newBinds, List{name, init})
	}
	out := List{Symbol("let"), newBinds}
	for _, bodyExpr := range form[2:] {
		if hygienic {
			bodyExpr = substitute(bodyExpr, renames)
		}
		ex, err := x.expand(env, bodyExpr, hygienic)
		if err != nil {
			return nil, err
		}
		out = append(out, ex)
	}
	return out, nil
}

// substitute replaces symbols according to renames, respecting quote
// and inner let shadowing.
func substitute(expr Value, renames map[Symbol]Symbol) Value {
	switch e := expr.(type) {
	case Symbol:
		if r, ok := renames[e]; ok {
			return r
		}
		return e
	case List:
		if len(e) == 0 {
			return e
		}
		if h, ok := e[0].(Symbol); ok {
			if h == "quote" || h == "defmacro" {
				return e
			}
			if h == "let" && len(e) >= 2 {
				inner := make(map[Symbol]Symbol, len(renames))
				for k, v := range renames {
					inner[k] = v
				}
				out := List{h}
				binds, ok := e[1].(List)
				if !ok {
					return e
				}
				nb := make(List, 0, len(binds))
				for _, b := range binds {
					pair, ok := b.(List)
					if !ok || len(pair) != 2 {
						return e
					}
					nm, _ := pair[0].(Symbol)
					nb = append(nb, List{nm, substitute(pair[1], inner)})
					delete(inner, nm)
				}
				out = append(out, nb)
				for _, be := range e[2:] {
					out = append(out, substitute(be, inner))
				}
				return out
			}
		}
		out := make(List, len(e))
		for i, sub := range e {
			out[i] = substitute(sub, renames)
		}
		return out
	default:
		return e
	}
}

// Run expands and evaluates one top-level form.
func Run(env *Env, x *Expander, form Value) (Value, error) {
	ex, err := x.Expand(env, form)
	if err != nil {
		return nil, err
	}
	return Eval(env, ex)
}

// RunProgram parses src and runs every form, returning the last value,
// the environment and the expander (for step accounting).
func RunProgram(src string, budget int) (Value, *Env, *Expander, error) {
	forms, err := Parse(src)
	if err != nil {
		return nil, nil, nil, err
	}
	env := NewGlobalEnv()
	x := NewExpander(budget)
	var out Value
	for _, f := range forms {
		v, err := Run(env, x, f)
		if err != nil {
			return nil, env, x, err
		}
		out = v
	}
	return out, env, x, nil
}
