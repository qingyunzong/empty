//go:build linux

package dataeng

import (
	"os"
	"syscall"
)

type fileIdentity struct {
	device uint64
	inode  uint64
}

func identifyFile(info os.FileInfo) (fileIdentity, bool) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, false
	}
	return fileIdentity{
		device: uint64(stat.Dev),
		inode:  stat.Ino,
	}, true
}
