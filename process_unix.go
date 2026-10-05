//go:build unix

package executor

import (
	"os/exec"
	"syscall"
)

// configureCmd puts the child in its own process group so Kill can reap the
// whole tree; otherwise grandchildren keep the output pipes open and the
// drain would block until they exit.
func configureCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcess signals the entire process group.
func killProcess(cmd *exec.Cmd) error {
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
}
