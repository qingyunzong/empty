//go:build !(linux || darwin || freebsd || netbsd || openbsd || dragonfly)

package dirwalk

import "os"

// fileID is unavailable on this platform; identities fall back to zero,
// which disables identity-based cycle detection.
func fileID(fi os.FileInfo) FileID {
	return FileID{}
}
