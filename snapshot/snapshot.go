package snapshot

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"sort"
	"sync"
	"time"
)

// Config tunes stability detection. The zero value is ready to use.
type Config struct {
	// StableScans is the number of consecutive complete scans in which a
	// file must be observed unchanged before it is delivered.
	// Default: 2.
	StableScans int

	// StableAge, when > 0, additionally requires the file's (normalized)
	// modification time to be at least this far in the past at delivery
	// time. Default: 0 (disabled).
	StableAge time.Duration

	// MtimePrecision normalizes modification times before comparison to
	// absorb timestamp precision differences between servers and
	// protocol versions (SFTP v3 carries whole seconds).
	// Default: 1 second.
	MtimePrecision time.Duration

	// Ignore excludes entries from scanning. nil uses DefaultIgnore,
	// which skips common in-progress upload names (.tmp, .part, ...).
	// Set to IgnoreNone to disable filtering entirely.
	Ignore func(path string, isDir bool) bool

	// NoDigest disables content hashing. Digests are only computed for
	// files whose FileSystem does not provide a FileID; they power
	// rename detection and change tracking via digest generations.
	NoDigest bool

	// MaxDigestBytes skips digesting files larger than this; such files
	// fall back to path+size+mtime identity only. 0 means unlimited.
	MaxDigestBytes int64

	// Now supplies the current time, mainly for tests. nil uses time.Now.
	Now func() time.Time
}

func (c *Config) withDefaults() Config {
	out := *c
	if out.StableScans <= 0 {
		out.StableScans = 2
	}
	if out.MtimePrecision <= 0 {
		out.MtimePrecision = time.Second
	}
	if out.Ignore == nil {
		out.Ignore = DefaultIgnore
	}
	if out.Now == nil {
		out.Now = time.Now
	}
	return out
}

// File is a stable file ready for ingestion.
type File struct {
	Path    string
	Size    int64
	ModTime time.Time
	// Digest is the hex SHA-256 of the content, if computed.
	Digest string
	// Gen is the digest generation: it changes whenever the content
	// behind an identity changes, and survives renames.
	Gen uint64
}

// fileState is the committed observation record for one identity.
type fileState struct {
	Key       string `json:"key"`
	Path      string `json:"path"`
	Size      int64  `json:"size"`
	Mtime     int64  `json:"mtime"` // normalized, unix nanos
	Digest    string `json:"digest,omitempty"`
	Gen       uint64 `json:"gen"`
	Seen      int    `json:"seen"`
	Delivered bool   `json:"delivered"`
}

// Snapshotter tracks a remote directory tree across scans and delivers
// files once they satisfy the configured stability conditions.
//
// State advances only when a scan completes successfully: a cancelled or
// failed scan leaves the committed state untouched, so resuming never
// treats half-observed files as stable.
type Snapshotter struct {
	mu        sync.Mutex
	fs        FileSystem
	cfg       Config
	committed map[string]*fileState
	digestIdx map[string]string // digest -> key, for rename detection
	nextGen   uint64
}

// New creates a Snapshotter reading from fs.
func New(fs FileSystem, cfg Config) *Snapshotter {
	return &Snapshotter{
		fs:        fs,
		cfg:       cfg.withDefaults(),
		committed: make(map[string]*fileState),
		digestIdx: make(map[string]string),
		nextGen:   1,
	}
}

// Scan walks the tree rooted at root and returns files that became stable
// in this scan. Each file is delivered at most once per content
// generation. If the scan is cancelled or fails, no observation is
// committed and the next scan starts from the last complete state.
func (s *Snapshotter) Scan(ctx context.Context, root string) ([]File, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entries, err := s.collect(ctx, root)
	if err != nil {
		return nil, err
	}

	pending := make(map[string]*fileState, len(entries))
	currentPaths := make(map[string]bool, len(entries))
	for _, e := range entries {
		currentPaths[e.Path] = true
	}

	for _, e := range entries {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		st, err := s.observe(ctx, e, currentPaths)
		if err != nil {
			return nil, err
		}
		pending[st.Key] = st
	}

	var delivered []File
	now := s.cfg.Now()
	for _, st := range pending {
		if st.Seen >= s.cfg.StableScans && !st.Delivered && s.ageSatisfied(st, now) {
			st.Delivered = true
			delivered = append(delivered, File{
				Path:    st.Path,
				Size:    st.Size,
				ModTime: time.Unix(0, st.Mtime),
				Digest:  st.Digest,
				Gen:     st.Gen,
			})
		}
	}
	sort.Slice(delivered, func(i, j int) bool { return delivered[i].Path < delivered[j].Path })

	s.committed = pending
	s.rebuildDigestIndex()
	return delivered, nil
}

// collect lists the whole tree without mutating any state.
func (s *Snapshotter) collect(ctx context.Context, root string) ([]DirEntry, error) {
	var files []DirEntry
	queue := []string{root}
	for len(queue) > 0 {
		dir := queue[0]
		queue = queue[1:]
		cursor := ""
		for {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			page, next, err := s.fs.List(ctx, dir, cursor)
			if err != nil {
				return nil, fmt.Errorf("list %s: %w", dir, err)
			}
			for _, e := range page {
				if s.cfg.Ignore(e.Path, e.IsDir) {
					continue
				}
				if e.IsDir {
					queue = append(queue, e.Path)
					continue
				}
				files = append(files, e)
			}
			if next == "" {
				break
			}
			cursor = next
		}
	}
	return files, nil
}

// observe folds one entry into a pending state derived from the committed
// state, resolving identity through FileID, path, and digest generation.
func (s *Snapshotter) observe(ctx context.Context, e DirEntry, currentPaths map[string]bool) (*fileState, error) {
	mtime := e.ModTime.Truncate(s.cfg.MtimePrecision).UnixNano()

	var key, digest string
	if e.HasID {
		key = fmt.Sprintf("ino:%d:%d", e.ID.Dev, e.ID.Ino)
	} else {
		key = "path:" + e.Path
		if !s.cfg.NoDigest && (s.cfg.MaxDigestBytes <= 0 || e.Size <= s.cfg.MaxDigestBytes) {
			d, err := s.digest(ctx, e.Path)
			if err != nil {
				return nil, err
			}
			digest = d
		}
	}

	prev := s.committed[key]
	if prev == nil && digest != "" {
		// Rename without inode support: the same digest committed under
		// a vanished path carries its observation history over.
		if oldKey, ok := s.digestIdx[digest]; ok {
			if old, ok := s.committed[oldKey]; ok && !currentPaths[old.Path] {
				prev = old
			}
		}
	}

	st := &fileState{
		Key:    key,
		Path:   e.Path,
		Size:   e.Size,
		Mtime:  mtime,
		Digest: digest,
		Seen:   1,
		Gen:    s.allocGen(),
	}
	if prev == nil {
		return st, nil
	}

	sameContent := prev.Size == e.Size && prev.Digest == digest
	if digest == "" {
		// Without a digest, mtime is the only change signal we have.
		sameContent = sameContent && prev.Mtime == mtime
	}
	if sameContent {
		st.Gen = prev.Gen
		st.Delivered = prev.Delivered
		if prev.Mtime == mtime {
			st.Seen = prev.Seen + 1
		}
	}
	return st, nil
}

func (s *Snapshotter) digest(ctx context.Context, p string) (string, error) {
	rc, err := s.fs.Open(ctx, p)
	if err != nil {
		return "", fmt.Errorf("open %s: %w", p, err)
	}
	defer rc.Close()
	h := sha256.New()
	if _, err := io.Copy(h, rc); err != nil {
		return "", fmt.Errorf("read %s: %w", p, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func (s *Snapshotter) ageSatisfied(st *fileState, now time.Time) bool {
	if s.cfg.StableAge <= 0 {
		return true
	}
	return now.Sub(time.Unix(0, st.Mtime)) >= s.cfg.StableAge
}

func (s *Snapshotter) allocGen() uint64 {
	g := s.nextGen
	s.nextGen++
	return g
}

func (s *Snapshotter) rebuildDigestIndex() {
	idx := make(map[string]string, len(s.committed))
	for _, st := range s.committed {
		if st.Digest == "" {
			continue
		}
		if _, exists := idx[st.Digest]; !exists {
			idx[st.Digest] = st.Key
		}
	}
	s.digestIdx = idx
}

// persisted is the wire format for Export/Import.
type persisted struct {
	Version int          `json:"version"`
	NextGen uint64       `json:"nextGen"`
	States  []*fileState `json:"states"`
}

// Export serializes the committed observation state so a restarted
// service resumes from the last complete scan. State from cancelled
// scans is never included, because it is never committed.
func (s *Snapshotter) Export() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	states := make([]*fileState, 0, len(s.committed))
	for _, st := range s.committed {
		states = append(states, st)
	}
	sort.Slice(states, func(i, j int) bool { return states[i].Key < states[j].Key })
	return json.Marshal(persisted{Version: 1, NextGen: s.nextGen, States: states})
}

// Import restores state previously produced by Export.
func (s *Snapshotter) Import(data []byte) error {
	var p persisted
	if err := json.Unmarshal(data, &p); err != nil {
		return fmt.Errorf("import snapshot state: %w", err)
	}
	if p.Version != 1 {
		return fmt.Errorf("import snapshot state: unsupported version %d", p.Version)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.committed = make(map[string]*fileState, len(p.States))
	for _, st := range p.States {
		s.committed[st.Key] = st
	}
	s.nextGen = p.NextGen
	if s.nextGen == 0 {
		s.nextGen = 1
	}
	s.rebuildDigestIndex()
	return nil
}

// DefaultIgnore skips names commonly used for in-progress uploads and
// editor/OS noise: dotfiles, and the suffixes .tmp, .part, .partial,
// .crdownload, .download, .filepart, .swp and trailing ~.
func DefaultIgnore(p string, isDir bool) bool {
	base := path.Base(p)
	if base == "" || base[0] == '.' {
		return true
	}
	switch path.Ext(base) {
	case ".tmp", ".part", ".partial", ".crdownload", ".download", ".filepart", ".swp":
		return true
	}
	return base[len(base)-1] == '~'
}

// IgnoreNone disables entry filtering.
func IgnoreNone(string, bool) bool { return false }
