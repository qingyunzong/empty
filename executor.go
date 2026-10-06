package execcache

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
)

// CommandExecutor runs requests as real OS processes. A non-zero exit
// code or a start failure is reported as an error and is therefore
// never cached.
type CommandExecutor struct {
	// InheritEnv controls whether the process environment is included
	// in addition to req.Env.
	InheritEnv bool
}

// Execute runs req.Command, capturing stdout and stderr.
func (e CommandExecutor) Execute(ctx context.Context, req Request) (Result, error) {
	if len(req.Command) == 0 {
		return Result{}, errors.New("execcache: empty command")
	}
	cmd := exec.CommandContext(ctx, req.Command[0], req.Command[1:]...)
	if e.InheritEnv {
		cmd.Env = os.Environ()
	}
	for k, v := range req.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	err := cmd.Run()
	res := Result{Stdout: stdout.Bytes(), Stderr: stderr.Bytes()}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			res.ExitCode = exitErr.ExitCode()
			return res, fmt.Errorf("execcache: command exited with code %d", res.ExitCode)
		}
		return res, fmt.Errorf("execcache: command failed: %w", err)
	}
	return res, nil
}
