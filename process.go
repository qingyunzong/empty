package executor

import (
	"context"
	"io"
	"os"
	"os/exec"
)

// Process is a running subprocess with drainable output streams.
type Process interface {
	Stdout() io.ReadCloser
	Stderr() io.ReadCloser
	Wait() error
	Kill() error
}

// Starter launches processes. It is injectable so tests can substitute
// fake processes for real ones.
type Starter interface {
	Start(ctx context.Context, name string, args ...string) (Process, error)
}

// ExecStarter launches real OS processes via os/exec.
type ExecStarter struct{}

func (ExecStarter) Start(_ context.Context, name string, args ...string) (Process, error) {
	cmd := exec.Command(name, args...)
	configureCmd(cmd)

	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	stderrR, stderrW, err := os.Pipe()
	if err != nil {
		stdoutR.Close()
		stdoutW.Close()
		return nil, err
	}
	cmd.Stdout = stdoutW
	cmd.Stderr = stderrW

	if err := cmd.Start(); err != nil {
		stdoutR.Close()
		stdoutW.Close()
		stderrR.Close()
		stderrW.Close()
		return nil, err
	}
	// The parent drops its write ends so readers see EOF once the child exits.
	stdoutW.Close()
	stderrW.Close()

	return &execProcess{cmd: cmd, stdout: stdoutR, stderr: stderrR}, nil
}

type execProcess struct {
	cmd    *exec.Cmd
	stdout *os.File
	stderr *os.File
}

func (p *execProcess) Stdout() io.ReadCloser { return p.stdout }
func (p *execProcess) Stderr() io.ReadCloser { return p.stderr }
func (p *execProcess) Wait() error           { return p.cmd.Wait() }
func (p *execProcess) Kill() error           { return killProcess(p.cmd) }
