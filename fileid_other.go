//go:build !linux

package dataeng

import "os"

type fileIdentity struct {
	device uint64
	inode  uint64
}

func identifyFile(os.FileInfo) (fileIdentity, bool) {
	return fileIdentity{}, false
}
