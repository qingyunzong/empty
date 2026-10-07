package effectcheck

// StmtKind identifies the kind of an IR statement.
type StmtKind int

const (
	ReadStmt StmtKind = iota
	WriteStmt
	CallStmt
	ThrowStmt
	ReturnStmt
)

// Stmt is one statement in a function body. Path is the source path of the
// statement and is carried into every effect it produces.
type Stmt struct {
	Kind   StmtKind
	Region string // Read, Write, Return
	Target string // Call
	Exc    string // Throw
	Path   string
}

// Func is a function in the program graph. Locals names the abstract regions
// allocated by the function itself; a local region must not escape via return.
type Func struct {
	Name   string
	Locals map[string]bool
	Body   []Stmt
}

// IsLocal reports whether region is local to the function.
func (f *Func) IsLocal(region string) bool {
	return f.Locals[region]
}

// Program is a set of named functions forming a call graph.
type Program struct {
	Funcs map[string]*Func
}

// NewProgram returns a program built from the given functions.
func NewProgram(funcs ...*Func) *Program {
	p := &Program{Funcs: make(map[string]*Func, len(funcs))}
	for _, f := range funcs {
		p.Funcs[f.Name] = f
	}
	return p
}

// callees returns the names of functions directly called by f.
func (p *Program) callees(f *Func) []string {
	var out []string
	for _, st := range f.Body {
		if st.Kind == CallStmt {
			out = append(out, st.Target)
		}
	}
	return out
}

// callers builds the reverse call edges: callee -> set of callers.
func (p *Program) callers() map[string]map[string]struct{} {
	out := make(map[string]map[string]struct{})
	for name, f := range p.Funcs {
		for _, callee := range p.callees(f) {
			m := out[callee]
			if m == nil {
				m = make(map[string]struct{})
				out[callee] = m
			}
			m[name] = struct{}{}
		}
	}
	return out
}
