package effectcheck

import "fmt"

// Pos identifies a source location.
type Pos struct {
	File string
	Line int
	Col  int
}

func (p Pos) String() string {
	if p.File == "" {
		return fmt.Sprintf("%d:%d", p.Line, p.Col)
	}
	return fmt.Sprintf("%s:%d:%d", p.File, p.Line, p.Col)
}

// Program is a set of global regions and functions.
type Program struct {
	Globals []string
	Funcs   []*Func
}

// Func returns the function with the given name, or nil.
func (p *Program) Func(name string) *Func {
	for _, f := range p.Funcs {
		if f.Name == name {
			return f
		}
	}
	return nil
}

// Func is a function definition.
type Func struct {
	Name   string
	Params []string
	Body   []Stmt
	P      Pos
}

// Stmt is a function body statement.
type Stmt interface {
	Pos() Pos
}

// RegionDecl declares a function-local region: "region r".
type RegionDecl struct {
	Name string
	P    Pos
}

func (s *RegionDecl) Pos() Pos { return s.P }

// ReadStmt reads a region: "read r".
type ReadStmt struct {
	Region string
	P      Pos
}

func (s *ReadStmt) Pos() Pos { return s.P }

// WriteStmt writes a region: "write r".
type WriteStmt struct {
	Region string
	P      Pos
}

func (s *WriteStmt) Pos() Pos { return s.P }

// CallStmt calls a function: "call f(a, b)".
type CallStmt struct {
	Callee string
	Args   []string
	P      Pos
}

func (s *CallStmt) Pos() Pos { return s.P }

// ThrowStmt raises an exception: "throw E".
type ThrowStmt struct {
	Exn string
	P   Pos
}

func (s *ThrowStmt) Pos() Pos { return s.P }

// ReturnStmt returns a region: "return r".
type ReturnStmt struct {
	Region string
	P      Pos
}

func (s *ReturnStmt) Pos() Pos { return s.P }
