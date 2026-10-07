package dirwalk

import (
	"context"
	"io/fs"
	"os"
)

// OSFS is an Adapter backed by the real operating-system filesystem.
type OSFS struct{}

func (OSFS) OpenDir(ctx context.Context, path string) (Handle, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return os.Open(path)
}

func (OSFS) ReadDir(ctx context.Context, h Handle) ([]Entry, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	des, err := h.(*os.File).ReadDir(-1)
	if err != nil {
		return nil, err
	}
	out := make([]Entry, 0, len(des))
	for _, de := range des {
		e := Entry{Name: de.Name(), Type: modeType(de.Type())}
		if fi, err := de.Info(); err == nil {
			e.ID = fileID(fi)
		}
		out = append(out, e)
	}
	return out, nil
}

func (OSFS) Stat(ctx context.Context, path string) (Entry, error) {
	if err := ctx.Err(); err != nil {
		return Entry{}, err
	}
	fi, err := os.Stat(path)
	if err != nil {
		return Entry{}, err
	}
	return Entry{Name: fi.Name(), Type: modeType(fi.Mode()), ID: fileID(fi)}, nil
}

func (OSFS) Close(h Handle) error {
	return h.(*os.File).Close()
}

func modeType(m fs.FileMode) EntryType {
	switch {
	case m.IsDir():
		return TypeDir
	case m&fs.ModeSymlink != 0:
		return TypeSymlink
	case m.IsRegular():
		return TypeFile
	default:
		return TypeOther
	}
}
