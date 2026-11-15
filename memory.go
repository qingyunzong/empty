package dataeng

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"fmt"
	"sort"
	"sync"
)

// MemoryBackend is an in-memory Backend implementation. It models multiple
// concurrent uploads to the same object key (each with its own upload ID)
// and monotonically increasing object generations, which makes it useful for
// tests and local development.
type MemoryBackend struct {
	mu       sync.Mutex
	uploads  map[string]*memoryUpload
	objects  map[string][]memoryObject
	uploadsN int64
	gen      int64
}

type memoryUpload struct {
	key      string
	uploadID string
	parts    map[int]memoryPart
}

type memoryPart struct {
	etag string
	body []byte
}

type memoryObject struct {
	info ObjectInfo
	data []byte
}

// NewMemoryBackend returns an empty in-memory backend.
func NewMemoryBackend() *MemoryBackend {
	return &MemoryBackend{
		uploads: make(map[string]*memoryUpload),
		objects: make(map[string][]memoryObject),
	}
}

func uploadKey(key, uploadID string) string { return key + "\x00" + uploadID }

// InitiateUpload starts a new upload with a fresh upload ID.
func (m *MemoryBackend) InitiateUpload(_ context.Context, key string) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.uploadsN++
	id := fmt.Sprintf("upload-%d", m.uploadsN)
	m.uploads[uploadKey(key, id)] = &memoryUpload{key: key, uploadID: id, parts: make(map[int]memoryPart)}
	return id, nil
}

// UploadPart stores a part under the given upload ID.
func (m *MemoryBackend) UploadPart(_ context.Context, key, uploadID string, number int, body []byte) (string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	up, ok := m.uploads[uploadKey(key, uploadID)]
	if !ok {
		return "", ErrUploadNotFound
	}
	sum := md5.Sum(body)
	etag := hex.EncodeToString(sum[:])
	cp := make([]byte, len(body))
	copy(cp, body)
	up.parts[number] = memoryPart{etag: etag, body: cp}
	return etag, nil
}

// ListParts returns the parts stored under the given upload ID only.
func (m *MemoryBackend) ListParts(_ context.Context, key, uploadID string) ([]RemotePart, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	up, ok := m.uploads[uploadKey(key, uploadID)]
	if !ok {
		return nil, ErrUploadNotFound
	}
	out := make([]RemotePart, 0, len(up.parts))
	for n, p := range up.parts {
		out = append(out, RemotePart{Number: n, ETag: p.etag, Size: int64(len(p.body))})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Number < out[j].Number })
	return out, nil
}

// CompleteUpload assembles the referenced parts into a new object
// generation and removes the upload.
func (m *MemoryBackend) CompleteUpload(_ context.Context, key, uploadID string, parts []PartRef) (ObjectInfo, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	up, ok := m.uploads[uploadKey(key, uploadID)]
	if !ok {
		return ObjectInfo{}, ErrUploadNotFound
	}
	var data []byte
	partDigests := make([]byte, 0, len(parts)*md5.Size)
	prev := 0
	for i, ref := range parts {
		if ref.Number <= prev && i > 0 {
			return ObjectInfo{}, fmt.Errorf("%w: parts not ascending", ErrInvalidPart)
		}
		prev = ref.Number
		p, ok := up.parts[ref.Number]
		if !ok || p.etag != ref.ETag {
			return ObjectInfo{}, fmt.Errorf("%w: part %d", ErrInvalidPart, ref.Number)
		}
		data = append(data, p.body...)
		raw, _ := hex.DecodeString(p.etag)
		partDigests = append(partDigests, raw...)
	}
	sum := md5.Sum(partDigests)
	m.gen++
	info := ObjectInfo{
		Key:        key,
		Generation: m.gen,
		ETag:       fmt.Sprintf("%s-%d", hex.EncodeToString(sum[:]), len(parts)),
		Size:       int64(len(data)),
	}
	m.objects[key] = append(m.objects[key], memoryObject{info: info, data: data})
	delete(m.uploads, uploadKey(key, uploadID))
	return info, nil
}

// AbortUpload discards the upload.
func (m *MemoryBackend) AbortUpload(_ context.Context, key, uploadID string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := uploadKey(key, uploadID)
	if _, ok := m.uploads[k]; !ok {
		return ErrUploadNotFound
	}
	delete(m.uploads, k)
	return nil
}

// GetObject returns the latest generation of key, for inspection in tests
// and local tooling. It is not part of the Backend interface.
func (m *MemoryBackend) GetObject(key string) (ObjectInfo, []byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	versions := m.objects[key]
	if len(versions) == 0 {
		return ObjectInfo{}, nil, fmt.Errorf("dataeng: object %q not found", key)
	}
	latest := versions[len(versions)-1]
	cp := make([]byte, len(latest.data))
	copy(cp, latest.data)
	return latest.info, cp, nil
}

// Generations returns the number of committed generations for key.
func (m *MemoryBackend) Generations(key string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.objects[key])
}
