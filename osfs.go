package treewalk

import (
	"os"
	"syscall"
)

// OSAdapter is an Adapter backed by the real operating system.
type OSAdapter struct{}

func (OSAdapter) Lstat(path string) (FileInfo, error) {
	fi, err := os.Lstat(path)
	if err != nil {
		return FileInfo{}, err
	}
	return infoFromOS(fi), nil
}

func (OSAdapter) Stat(path string) (FileInfo, error) {
	fi, err := os.Stat(path)
	if err != nil {
		return FileInfo{}, err
	}
	return infoFromOS(fi), nil
}

func (OSAdapter) Open(path string) (DirHandle, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	return osHandle{f: f}, nil
}

func infoFromOS(fi os.FileInfo) FileInfo {
	out := FileInfo{
		IsDir:     fi.IsDir(),
		IsSymlink: fi.Mode()&os.ModeSymlink != 0,
		Size:      fi.Size(),
	}
	if st, ok := fi.Sys().(*syscall.Stat_t); ok {
		out.ID = Identity{Dev: uint64(st.Dev), Ino: uint64(st.Ino)}
	}
	return out
}

type osHandle struct{ f *os.File }

func (h osHandle) ReadDir() ([]string, error) { return h.f.Readdirnames(-1) }
func (h osHandle) Close() error               { return h.f.Close() }
