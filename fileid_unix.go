//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

package dirwalk

import (
	"os"
	"syscall"
)

func fileID(fi os.FileInfo) FileID {
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		return FileID{Dev: uint64(st.Dev), Ino: uint64(st.Ino)}
	}
	return FileID{}
}
