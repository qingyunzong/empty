package dataeng

import "os"

func stampOf(info os.FileInfo) FileStamp {
	stamp := FileStamp{
		Size:    info.Size(),
		ModTime: info.ModTime(),
	}
	if identity, ok := identifyFile(info); ok {
		stamp.Device = identity.device
		stamp.Inode = identity.inode
	}
	return stamp
}

func stampMatches(expected, actual FileStamp) bool {
	if expected.Inode == 0 || actual.Inode == 0 {
		// File identity is unavailable on this platform. Avoid false rotation
		// reports; truncation is still detected from the read offset.
		return true
	}
	return expected.Device == actual.Device && expected.Inode == actual.Inode
}
