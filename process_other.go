//go:build !unix

package executor

import "os/exec"

func configureCmd(cmd *exec.Cmd) {}

func killProcess(cmd *exec.Cmd) error { return cmd.Process.Kill() }
