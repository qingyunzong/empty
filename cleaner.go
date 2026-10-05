// Package cleaner 实现基于持久租约的暂存文件清理器。
//
// 语义约定：
//   - 每个暂存文件对应一条持久化租约（名字、代际、截止时间），租约落盘后
//     断电重启不丢失。
//   - 过期判断为 now >= deadline（now 大于等于截止即回收）。
//   - 续租（Renew）与删除（Sweep）在同一把互斥锁保护的临界区内决胜，
//     先拿到锁者生效，不存在中间态。
//   - 每次写入同名文件都会提升代际号；旧代际的清理/续租决策无法作用于
//     新代际的同名文件。
package cleaner

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"strings"
	"time"
)

// Lease 描述一个暂存文件的租约。
type Lease struct {
	Name       string    `json:"name"`
	Generation uint64    `json:"generation"`
	Deadline   time.Time `json:"deadline"`
}

var (
	// ErrNotFound 表示租约不存在（文件未登记或已被回收）。
	ErrNotFound = errors.New("cleaner: lease not found")
	// ErrStaleGeneration 表示调用方持有的是旧代际，目标文件已被新代际替换。
	ErrStaleGeneration = errors.New("cleaner: stale generation")
	// ErrInvalidName 表示文件名非法。
	ErrInvalidName = errors.New("cleaner: invalid file name")
)

const leasesFileName = "leases.json"

// Store 管理一个目录下的暂存文件及其租约。
// 所有公开方法都可并发调用；续租与删除在同一临界区内串行决胜。
type Store struct {
	dir string

	mu      sync.Mutex
	leases  map[string]Lease // name -> lease
	nextGen uint64
}

// Open 打开（必要时创建）dir 下的存储，并加载持久化租约以完成断电恢复。
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	s := &Store{
		dir:     dir,
		leases:  make(map[string]Lease),
		nextGen: 1,
	}
	data, err := os.ReadFile(filepath.Join(dir, leasesFileName))
	switch {
	case err == nil:
		var leases []Lease
		if err := json.Unmarshal(data, &leases); err != nil {
			return nil, fmt.Errorf("cleaner: corrupt leases file: %w", err)
		}
		for _, l := range leases {
			s.leases[l.Name] = l
			if l.Generation >= s.nextGen {
				s.nextGen = l.Generation + 1
			}
		}
	case errors.Is(err, os.ErrNotExist):
		// 首次启动，无租约可恢复。
	default:
		return nil, err
	}
	return s, nil
}

// Put 以给定截止时间写入暂存文件并登记租约，返回新代际号。
// 同名文件的旧租约被覆盖，代际号单调递增。
func (s *Store) Put(name string, data []byte, deadline time.Time) (uint64, error) {
	if err := checkName(name); err != nil {
		return 0, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	gen := s.nextGen
	s.nextGen++
	if err := s.writeFileAtomic(name, data); err != nil {
		return 0, err
	}
	s.leases[name] = Lease{Name: name, Generation: gen, Deadline: deadline}
	if err := s.persistLocked(); err != nil {
		return 0, err
	}
	return gen, nil
}

// Renew 续租：将 name 的截止时间更新为 deadline。
// 仅当 generation 与当前代际一致时生效；旧代际的续租返回 ErrStaleGeneration。
// 与 Sweep 在同一临界区决胜：拿到锁时租约已过期被删则返回 ErrNotFound。
func (s *Store) Renew(name string, generation uint64, deadline time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	l, ok := s.leases[name]
	if !ok {
		return ErrNotFound
	}
	if l.Generation != generation {
		return ErrStaleGeneration
	}
	l.Deadline = deadline
	s.leases[name] = l
	return s.persistLocked()
}

// Sweep 回收所有满足 now >= deadline 的暂存文件，返回被删除的文件名（有序）。
// 同时清理目录中没有租约登记的孤儿文件（例如断电窗口内残留的临时产物）。
func (s *Store) Sweep(now time.Time) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	var removed []string
	for name, l := range s.leases {
		if !now.Before(l.Deadline) { // now >= deadline 即过期
			if err := os.Remove(s.path(name)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return nil, err
			}
			delete(s.leases, name)
			removed = append(removed, name)
		}
	}
	// 孤儿文件回收：目录中存在但无租约的非管理文件。
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || name == leasesFileName || strings.HasSuffix(name, ".tmp") {
			continue
		}
		if _, ok := s.leases[name]; ok {
			continue
		}
		if err := os.Remove(s.path(name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		removed = append(removed, name)
	}
	if len(removed) > 0 {
		if err := s.persistLocked(); err != nil {
			return nil, err
		}
		sort.Strings(removed)
	}
	return removed, nil
}

// Lease 返回 name 当前的租约。
func (s *Store) LeaseOf(name string) (Lease, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.leases[name]
	if !ok {
		return Lease{}, ErrNotFound
	}
	return l, nil
}

// Exists 报告 name 的暂存文件当前是否存在于磁盘。
func (s *Store) Exists(name string) bool {
	_, err := os.Stat(s.path(name))
	return err == nil
}

func (s *Store) path(name string) string { return filepath.Join(s.dir, name) }

// writeFileAtomic 先写临时文件并 fsync，再原子 rename，保证断电后不会出现半写文件。
func (s *Store) writeFileAtomic(name string, data []byte) error {
	tmp, err := os.CreateTemp(s.dir, name+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, s.path(name)); err != nil {
		os.Remove(tmpName)
		return err
	}
	return syncDir(s.dir)
}

// persistLocked 将租约表原子落盘（调用方须已持有 s.mu）。
func (s *Store) persistLocked() error {
	leases := make([]Lease, 0, len(s.leases))
	for _, l := range s.leases {
		leases = append(leases, l)
	}
	sort.Slice(leases, func(i, j int) bool { return leases[i].Name < leases[j].Name })
	data, err := json.Marshal(leases)
	if err != nil {
		return err
	}
	return s.writeFileAtomic(leasesFileName, data)
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func checkName(name string) error {
	if name == "" || name == leasesFileName ||
		strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return ErrInvalidName
	}
	return nil
}
