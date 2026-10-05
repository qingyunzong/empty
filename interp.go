package debuglib

import "errors"

// ErrFinished is returned when stepping past the end of a program.
var ErrFinished = errors.New("program finished")

// Stmt is a program statement. Line identifies its source line and is the
// key used for breakpoints.
type Stmt interface {
	Line() int
}

// Assign evaluates Value and stores it in the environment under Name.
type Assign struct {
	Ln    int
	Name  string
	Value Expr
}

func (s *Assign) Line() int { return s.Ln }

// Print evaluates Value and appends it to the output trace.
type Print struct {
	Ln    int
	Value Expr
}

func (s *Print) Line() int { return s.Ln }

// State is the full observable state of an execution.
type State struct {
	Env map[string]int64
	Out []int64
	PC  int // index of the next statement to execute
}

func NewState() *State {
	return &State{Env: map[string]int64{}}
}

// Program is a fixed sequence of statements executed in order.
type Program struct {
	Stmts []Stmt
}

// step executes exactly the statement at st.PC and advances PC.
func (p *Program) step(st *State) error {
	if st.PC >= len(p.Stmts) {
		return ErrFinished
	}
	switch s := p.Stmts[st.PC].(type) {
	case *Assign:
		v, err := s.Value.Eval(st.Env)
		if err != nil {
			return err
		}
		st.Env[s.Name] = v
	case *Print:
		v, err := s.Value.Eval(st.Env)
		if err != nil {
			return err
		}
		st.Out = append(st.Out, v)
	default:
		return errors.New("unknown statement type")
	}
	st.PC++
	return nil
}

// Run executes the whole program with no debugging and returns the final
// state. It is the reference implementation the debugger is checked against.
func Run(p *Program) (*State, error) {
	st := NewState()
	for st.PC < len(p.Stmts) {
		if err := p.step(st); err != nil {
			return st, err
		}
	}
	return st, nil
}
