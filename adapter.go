package protocheck

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
)

// Adapter connects the checker to an implementation under test.
type Adapter interface {
	Reset() error
	Apply(action string) error
	State() (string, error)
}

// SimAdapter simulates an implementation directly from the table.
// Fault-injection fields exist so tests can emulate broken implementations.
type SimAdapter struct {
	T *Table
	// AcceptIllegal makes Apply accept illegal actions without error.
	AcceptIllegal bool
	// IllegalTo, when non-empty, moves to this state on illegal actions
	// (and implies the illegal action is accepted).
	IllegalTo string
	// WrongTo overrides legal transition targets; key is from+"\x00"+action.
	WrongTo map[string]string

	state string
}

// NewSimAdapter returns a SimAdapter at the initial state.
func NewSimAdapter(t *Table) *SimAdapter {
	return &SimAdapter{T: t, state: t.Initial}
}

// Reset returns to the initial state.
func (s *SimAdapter) Reset() error {
	s.state = s.T.Initial
	return nil
}

// Apply performs one transition.
func (s *SimAdapter) Apply(action string) error {
	to, ok := s.T.Step(s.state, action)
	if !ok {
		if s.IllegalTo != "" {
			s.state = s.IllegalTo
			return nil
		}
		if s.AcceptIllegal {
			return nil
		}
		return fmt.Errorf("illegal action %q in state %q", action, s.state)
	}
	if w, hit := s.WrongTo[s.state+"\x00"+action]; hit {
		to = w
	}
	s.state = to
	return nil
}

// State reports the current state.
func (s *SimAdapter) State() (string, error) {
	return s.state, nil
}

// ExecAdapter drives an external implementation over stdin/stdout using
// JSON lines. Requests: {"op":"reset"} / {"op":"apply","action":"a"} /
// {"op":"state"}. Responses: {"ok":true} or {"error":"..."} and, for
// "state", {"ok":true,"state":"s"}.
type ExecAdapter struct {
	cmd *exec.Cmd
	in  io.WriteCloser
	enc *json.Encoder
	dec *json.Decoder
}

type execRequest struct {
	Op     string `json:"op"`
	Action string `json:"action,omitempty"`
}

type execResponse struct {
	OK    bool   `json:"ok"`
	State string `json:"state"`
	Error string `json:"error"`
}

// NewExecAdapter starts the given command as an implementation server.
func NewExecAdapter(name string, args ...string) (*ExecAdapter, error) {
	cmd := exec.Command(name, args...)
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start %s: %w", name, err)
	}
	return &ExecAdapter{
		cmd: cmd,
		in:  in,
		enc: json.NewEncoder(in),
		dec: json.NewDecoder(out),
	}, nil
}

func (e *ExecAdapter) call(req execRequest) (execResponse, error) {
	if err := e.enc.Encode(req); err != nil {
		return execResponse{}, fmt.Errorf("send %s: %w", req.Op, err)
	}
	var resp execResponse
	if err := e.dec.Decode(&resp); err != nil {
		return execResponse{}, fmt.Errorf("recv %s: %w", req.Op, err)
	}
	if resp.Error != "" {
		return resp, errors.New(resp.Error)
	}
	if !resp.OK {
		return resp, fmt.Errorf("implementation rejected %s without error message", req.Op)
	}
	return resp, nil
}

// Reset implements Adapter.
func (e *ExecAdapter) Reset() error {
	_, err := e.call(execRequest{Op: "reset"})
	return err
}

// Apply implements Adapter.
func (e *ExecAdapter) Apply(action string) error {
	_, err := e.call(execRequest{Op: "apply", Action: action})
	return err
}

// State implements Adapter.
func (e *ExecAdapter) State() (string, error) {
	resp, err := e.call(execRequest{Op: "state"})
	if err != nil {
		return "", err
	}
	return resp.State, nil
}

// Close shuts the implementation process down.
func (e *ExecAdapter) Close() error {
	e.in.Close()
	return e.cmd.Wait()
}
