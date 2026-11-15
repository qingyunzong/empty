package dataeng

import (
	"crypto"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
)

const defaultBlobAlgo = "sha256"

// blobRefsFile 是某个 blob 的独立来源关系清单。
type blobRefsFile struct {
	Algo   string    `json:"algo"`
	Digest string    `json:"digest"`
	Size   int64     `json:"size"`
	Refs   []BlobRef `json:"refs"`
}

// blobStore 管理内容寻址的正文数据与来源关系。
//
// 相同 (algo, digest) 的数据只在 blobs/data 下落一份；每个引用方在
// blobs/refs 下追加一条独立 BlobRef，重复引用按 (Role, Run, Target,
// RequestID, EventID) 幂等去重。
type blobStore struct {
	root  string
	fsync bool
}

func newBlobStore(root string, fsync bool) *blobStore {
	return &blobStore{root: root, fsync: fsync}
}

func digestBytes(algo string, body []byte) (string, error) {
	var h crypto.Hash
	switch algo {
	case "", "sha256":
		sum := sha256.Sum256(body)
		return hex.EncodeToString(sum[:]), nil
	default:
		_ = h
		return "", errors.New("dataeng: unsupported blob algo " + algo)
	}
}

// Put 写入正文数据（已存在则复用），并登记一条来源关系，返回完整 BlobRef。
func (b *blobStore) Put(algo, mime string, body []byte, ref BlobRef) (*BlobRef, error) {
	if algo == "" {
		algo = defaultBlobAlgo
	}
	digest, err := digestBytes(algo, body)
	if err != nil {
		return nil, err
	}
	dataPath := blobDataPath(b.root, algo, digest)
	if !fileExists(dataPath) {
		if err := atomicWrite(dataPath, body, b.fsync); err != nil {
			return nil, err
		}
	}
	ref.Algo = algo
	ref.Digest = digest
	ref.Size = int64(len(body))
	if mime != "" {
		ref.MIME = mime
	}
	if err := b.addRef(ref); err != nil {
		return nil, err
	}
	return &ref, nil
}

// PutRef 为外部已落盘的 blob（仅摘要已知）登记来源关系。
func (b *blobStore) PutRef(ref BlobRef) error {
	if ref.Algo == "" {
		ref.Algo = defaultBlobAlgo
	}
	if ref.Digest == "" {
		return ErrInvalidEvent
	}
	return b.addRef(ref)
}

func refKey(r BlobRef) string {
	return r.Role + "|" + r.Run + "|" + r.Target + "|" + r.RequestID + "|" + r.EventID
}

func (b *blobStore) addRef(ref BlobRef) error {
	refsPath := blobRefsPath(b.root, ref.Algo, ref.Digest)
	doc := blobRefsFile{Algo: ref.Algo, Digest: ref.Digest, Size: ref.Size}
	if fileExists(refsPath) {
		if err := readJSON(refsPath, &doc); err != nil {
			return err
		}
	}
	for _, existing := range doc.Refs {
		if refKey(existing) == refKey(ref) {
			return nil // 同一来源关系重复登记，幂等忽略
		}
	}
	if ref.Size == 0 {
		ref.Size = doc.Size
	}
	doc.Refs = append(doc.Refs, ref)
	doc.Size = ref.Size
	return writeJSON(refsPath, &doc, b.fsync)
}

// Read 按摘要取回正文数据。
func (b *blobStore) Read(algo, digest string) ([]byte, error) {
	if algo == "" {
		algo = defaultBlobAlgo
	}
	data, err := os.ReadFile(blobDataPath(b.root, algo, digest))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return data, err
}

// Refs 返回某 blob 的全部独立来源关系。
func (b *blobStore) Refs(algo, digest string) ([]BlobRef, error) {
	if algo == "" {
		algo = defaultBlobAlgo
	}
	path := blobRefsPath(b.root, algo, digest)
	if !fileExists(path) {
		return nil, ErrNotFound
	}
	var doc blobRefsFile
	if err := readJSON(path, &doc); err != nil {
		return nil, err
	}
	return doc.Refs, nil
}

// ensureLayout 预建顶层目录，避免空归档时目录缺失。
func (b *blobStore) ensureLayout() error {
	for _, d := range []string{
		filepath.Join(b.root, "blobs", "data"),
		filepath.Join(b.root, "blobs", "refs"),
		filepath.Join(b.root, "publish"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	return nil
}
