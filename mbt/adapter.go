package mbt

import (
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
)

// Observed is a snapshot reported by the implementation under test.
type Observed struct {
	State string         `json:"state"`
	Data  map[string]any `json:"data,omitempty"`
}

// Request is one call to the adapter.
type Request struct {
	Op     string `json:"op"` // "reset", "apply", "state"
	Action string `json:"action,omitempty"`
}

// Response is the adapter's reply to a Request.
type Response struct {
	OK    bool           `json:"ok"`
	Error string         `json:"error,omitempty"`
	State string         `json:"state,omitempty"`
	Data  map[string]any `json:"data,omitempty"`
}

// Adapter executes protocol actions against the implementation under test.
type Adapter interface {
	// Reset returns the implementation to its initial state and reports it.
	Reset() (Response, error)
	// Apply performs one action; a legal action must succeed, an illegal
	// action must fail with an error and leave the state unchanged.
	Apply(action string) (Response, error)
	// State reports the current observable state without changing it.
	State() (Response, error)
	io.Closer
}

// ExecAdapter talks to an adapter subprocess over JSON lines on
// stdin/stdout. Each Request is written as one JSON object per line;
// the subprocess must answer with one JSON object per line.
type ExecAdapter struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	dec    *json.Decoder
	closed bool
}

// NewExecAdapter starts the adapter subprocess.
func NewExecAdapter(argv ...string) (*ExecAdapter, error) {
	if len(argv) == 0 {
		return nil, fmt.Errorf("adapter command is empty")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("start adapter: %w", err)
	}
	return &ExecAdapter{cmd: cmd, stdin: stdin, dec: json.NewDecoder(stdout)}, nil
}

func (a *ExecAdapter) call(req Request) (Response, error) {
	if a.closed {
		return Response{}, fmt.Errorf("adapter is closed")
	}
	if err := json.NewEncoder(a.stdin).Encode(req); err != nil {
		return Response{}, fmt.Errorf("send %s: %w", req.Op, err)
	}
	var resp Response
	if err := a.dec.Decode(&resp); err != nil {
		return Response{}, fmt.Errorf("recv %s: %w", req.Op, err)
	}
	return resp, nil
}

func (a *ExecAdapter) Reset() (Response, error) { return a.call(Request{Op: "reset"}) }
func (a *ExecAdapter) State() (Response, error) { return a.call(Request{Op: "state"}) }
func (a *ExecAdapter) Apply(action string) (Response, error) {
	return a.call(Request{Op: "apply", Action: action})
}

// Close terminates the adapter subprocess.
func (a *ExecAdapter) Close() error {
	if a.closed {
		return nil
	}
	a.closed = true
	a.stdin.Close()
	return a.cmd.Wait()
}
