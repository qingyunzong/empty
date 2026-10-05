package executor

import (
	"context"
	"io"
	"os"
	"os/exec"
)

// ExecStarter starts a real OS process with os/exec. Stdout and stderr
// are plumbed through os.Pipe so Run controls draining and resource
// release precisely.
type ExecStarter struct {
	Name string
	Args []string
	Dir  string
	Env  []string // nil inherits the current environment
}

// Start implements Starter.
func (s ExecStarter) Start(ctx context.Context) (Process, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	cmd := exec.Command(s.Name, s.Args...)
	cmd.Dir = s.Dir
	if s.Env != nil {
		cmd.Env = s.Env
	}

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
	// The child holds its own copies of the write ends; drop ours so
	// readers observe EOF once the process exits.
	stdoutW.Close()
	stderrW.Close()

	return &execProcess{cmd: cmd, stdout: stdoutR, stderr: stderrR}, nil
}

type execProcess struct {
	cmd    *exec.Cmd
	stdout *os.File
	stderr *os.File
}

func (p *execProcess) Stdout() io.Reader { return p.stdout }
func (p *execProcess) Stderr() io.Reader { return p.stderr }

func (p *execProcess) Wait() error { return p.cmd.Wait() }

func (p *execProcess) Kill() error {
	if p.cmd.Process == nil {
		return nil
	}
	return p.cmd.Process.Kill()
}

// Close releases the read ends of the pipes. Run calls it only after
// both streams are drained, so no buffered output is lost.
func (p *execProcess) Close() error {
	err := p.stdout.Close()
	if e := p.stderr.Close(); err == nil {
		err = e
	}
	return err
}
