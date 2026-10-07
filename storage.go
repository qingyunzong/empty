package dedup

import "os"

// File is the storage boundary the DB persists through. Every method is a
// fault-injection point in tests: a crash between any two calls must leave
// the DB recoverable with no duplicated effects.
type File interface {
	ReadAt(p []byte, off int64) (int, error)
	WriteAt(p []byte, off int64) (int, error)
	Truncate(size int64) error
	Sync() error
	Close() error
}

type osFile struct{ f *os.File }

func (o osFile) ReadAt(p []byte, off int64) (int, error)  { return o.f.ReadAt(p, off) }
func (o osFile) WriteAt(p []byte, off int64) (int, error) { return o.f.WriteAt(p, off) }
func (o osFile) Truncate(size int64) error                { return o.f.Truncate(size) }
func (o osFile) Sync() error                              { return o.f.Sync() }
func (o osFile) Close() error                             { return o.f.Close() }

// OpenFile opens (creating if needed) the WAL file at path.
func OpenFile(path string) (File, error) {
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o644)
	if err != nil {
		return nil, err
	}
	return osFile{f: f}, nil
}
