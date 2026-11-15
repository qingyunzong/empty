package dataeng

import (
	"crypto/sha256"
	"os"
	"syscall"
)

// FileID 唯一标识磁盘上的一个文件（设备号 + inode）。
// rename 不改变 FileID，create 新文件会产生新的 FileID。
type FileID struct {
	Dev uint64
	Ino uint64
}

func fileIDOf(info os.FileInfo) FileID {
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		return FileID{Dev: uint64(st.Dev), Ino: uint64(st.Ino)}
	}
	return FileID{}
}

// Fingerprint 是文件头部内容的哈希，用于区分同一路径上的不同文件。
type Fingerprint [sha256.Size]byte

const fingerprintSize = 1024

// fingerprintLen 返回指纹应覆盖的字节数：文件不足 fingerprintSize 时
// 以当前大小为准，保证小文件增长后仍可按同一长度校验。
func fingerprintLen(size int64) int64 {
	if size < fingerprintSize {
		return size
	}
	return fingerprintSize
}

// fingerprintOf 计算文件前 length 字节的 SHA-256，不改变文件偏移。
// 文件不足 length 字节时返回 io.EOF。
func fingerprintOf(f *os.File, length int64) (Fingerprint, error) {
	var fp Fingerprint
	buf := make([]byte, length)
	if _, err := f.ReadAt(buf, 0); err != nil {
		return fp, err
	}
	return sha256.Sum256(buf), nil
}
