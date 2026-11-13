package dataeng

import (
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
)

// archiveMagic 是归档的固定标识头，紧跟其后的是零条或多条成员记录。
const archiveMagic = "ARCV1\n"

// 成员名称长度的合理性上限，超过即视为归档帧损坏。
const maxNameLength = 1 << 20

var (
	// ErrBadArchive 表示归档帧本身无法解析，例如标识头错误或字段非法。
	ErrBadArchive = errors.New("dataeng: 归档格式损坏")
	// ErrIncomplete 表示归档在所有成员结束前被截断。
	ErrIncomplete = errors.New("dataeng: 归档不完整，已在截断处停止")
	// ErrUnsafeName 表示成员名称包含 ".." 或以 "/" 开头，按规则跳过。
	ErrUnsafeName = errors.New("dataeng: 成员名称包含 \"..\" 或以 \"/\" 开头")
	// ErrMemberTooLarge 表示声明字节数超过调用方给出的上限，不读正文直接跳过。
	ErrMemberTooLarge = errors.New("dataeng: 成员声明字节数超过上限")
	// ErrSizeMismatch 表示实际读到的字节数与声明字节数不一致。
	ErrSizeMismatch = errors.New("dataeng: 实际字节数与声明字节数不一致")
	// ErrDigestMismatch 表示归档中记录的摘要与成员正文的实际摘要不一致。
	ErrDigestMismatch = errors.New("dataeng: 归档摘要与成员实际摘要不一致")
	// ErrUnexpectedDigest 表示成员实际摘要与调用方期望的摘要不一致。
	ErrUnexpectedDigest = errors.New("dataeng: 成员摘要与调用方期望不一致")
	// ErrDuplicateName 表示同名成员再次出现且摘要一致，只保留第一份。
	ErrDuplicateName = errors.New("dataeng: 同名成员重复，仅保留第一份")
	// ErrConflictingName 表示同名成员摘要不同，冲突的两份都不保留。
	ErrConflictingName = errors.New("dataeng: 同名成员摘要冲突，两份均不保留")
)

// Member 描述归档中的一个成员及其验收信息。
type Member struct {
	// Name 是成员名称。
	Name string
	// DeclaredSize 是归档头中声明的正文字节数。
	DeclaredSize int64
	// ActualSize 是实际从归档中读到的正文字节数。
	ActualSize int64
	// Digest 是归档头中记录的 SHA-256 摘要。
	Digest [sha256.Size]byte
	// Data 是成员正文；仅收录的成员会保留正文，被拒绝的成员该字段为 nil。
	Data []byte
}

// RejectedMember 记录一个未被收录的成员及其原因，跳过与失败分别归集。
type RejectedMember struct {
	// Member 是被跳过或拒绝成员的元数据，Data 始终为 nil，不保留已读字节。
	Member Member
	// Reason 是未收录原因，可与包内导出的哨兵错误用 errors.Is 比较。
	Reason error
}

// Result 是一次采集的结果。
type Result struct {
	// Members 是最终收录的成员，按首次通过验收的顺序排列。
	Members []Member
	// Rejected 是验收失败或因同名规则未收录的成员，不保留正文。
	Rejected []RejectedMember
	// Skipped 是按规则直接跳过的成员（名称非法或超过上限），不保留正文。
	Skipped []RejectedMember
	// Incomplete 为 true 表示归档在最后成员结束前被截断，已通过的成员仍保留。
	Incomplete bool
}

// UnsafeName 判断成员名称是否需要跳过：名称包含 ".." 或以 "/" 开头。
func UnsafeName(name string) bool {
	return len(name) > 0 && name[0] == '/' || containsDotDot(name)
}

func containsDotDot(name string) bool {
	for i := 0; i+1 < len(name); i++ {
		if name[i] == '.' && name[i+1] == '.' {
			return true
		}
	}
	return false
}

// Collect 从 r 中逐个读取并验收归档成员。
//
// maxMemberBytes 为单个成员声明字节数的上限：声明值超过上限时不读正文、
// 直接跳过该成员并继续处理后续成员；maxMemberBytes <= 0 表示不限制。
//
// expected 按成员名称给出调用方期望的 SHA-256 摘要；映射中存在的名称必须
// 与成员实际摘要一致，否则该成员失败。expected 可为 nil，表示不校验期望摘要。
//
// 归档截断时返回的 error 包装 ErrIncomplete，且 Result 中保留此前已通过的
// 成员；归档帧本身损坏时返回包装 ErrBadArchive 的错误且 Result 为 nil。
func Collect(r io.Reader, maxMemberBytes int64, expected map[string][sha256.Size]byte) (*Result, error) {
	result := &Result{}

	header := make([]byte, len(archiveMagic))
	if _, err := io.ReadFull(r, header); err != nil {
		return nil, fmt.Errorf("%w: 读取归档标识头失败: %v", ErrBadArchive, err)
	}
	if string(header) != archiveMagic {
		return nil, fmt.Errorf("%w: 非法归档标识头", ErrBadArchive)
	}

	acceptedIndex := make(map[string]int)
	acceptedDigest := make(map[string][sha256.Size]byte)
	conflicted := make(map[string]bool)

	for {
		name, declaredSize, storedDigest, err := readMemberHeader(r)
		if err != nil {
			if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
				result.Incomplete = true
				return result, fmt.Errorf("%w: 成员头被截断", ErrIncomplete)
			}
			return nil, err
		}
		if name == "" {
			// 名称长度为 0 的记录是归档结束标记。
			return result, nil
		}

		if UnsafeName(name) {
			result.Skipped = append(result.Skipped, RejectedMember{
				Member: Member{Name: name, DeclaredSize: declaredSize, Digest: storedDigest},
				Reason: ErrUnsafeName,
			})
			if err := drainBody(r, declaredSize); err != nil {
				result.Incomplete = true
				return result, fmt.Errorf("%w: 跳过成员 %q 时正文被截断", ErrIncomplete, name)
			}
			continue
		}

		if maxMemberBytes > 0 && declaredSize > maxMemberBytes {
			// 超过上限：不读入正文、不分配缓冲，仅推进流位置后继续。
			result.Skipped = append(result.Skipped, RejectedMember{
				Member: Member{Name: name, DeclaredSize: declaredSize, Digest: storedDigest},
				Reason: ErrMemberTooLarge,
			})
			if err := drainBody(r, declaredSize); err != nil {
				result.Incomplete = true
				return result, fmt.Errorf("%w: 超限成员 %q 的正文被截断", ErrIncomplete, name)
			}
			continue
		}

		data := make([]byte, declaredSize)
		n, readErr := io.ReadFull(r, data)
		actualSize := int64(n)
		if readErr != nil {
			// 正文未读满即到达流末尾：实际字节数与声明不一致，成员失败且不留字节。
			result.Rejected = append(result.Rejected, RejectedMember{
				Member: Member{
					Name:         name,
					DeclaredSize: declaredSize,
					ActualSize:   actualSize,
					Digest:       storedDigest,
				},
				Reason: ErrSizeMismatch,
			})
			if errors.Is(readErr, io.EOF) || errors.Is(readErr, io.ErrUnexpectedEOF) {
				result.Incomplete = true
				return result, fmt.Errorf("%w: 成员 %q 正文在 %d/%d 字节处被截断",
					ErrIncomplete, name, actualSize, declaredSize)
			}
			return nil, fmt.Errorf("读取成员 %q 正文失败: %w", name, readErr)
		}

		actualDigest := sha256.Sum256(data)
		member := Member{
			Name:         name,
			DeclaredSize: declaredSize,
			ActualSize:   actualSize,
			Digest:       storedDigest,
			Data:         data,
		}

		if storedDigest != actualDigest {
			member.Data = nil
			result.Rejected = append(result.Rejected, RejectedMember{Member: member, Reason: ErrDigestMismatch})
			continue
		}
		if want, ok := expected[name]; ok && want != actualDigest {
			member.Data = nil
			result.Rejected = append(result.Rejected, RejectedMember{Member: member, Reason: ErrUnexpectedDigest})
			continue
		}

		if conflicted[name] {
			// 该名称已发生过冲突，后续同名成员一律不收。
			member.Data = nil
			result.Rejected = append(result.Rejected, RejectedMember{Member: member, Reason: ErrConflictingName})
			continue
		}
		if existingDigest, dup := acceptedDigest[name]; dup {
			member.Data = nil
			if existingDigest == actualDigest {
				result.Rejected = append(result.Rejected, RejectedMember{Member: member, Reason: ErrDuplicateName})
				continue
			}
			// 摘要不同：移除第一份，两份都不要，并重建索引。
			removed := removeMember(result, acceptedIndex[name])
			removed.Data = nil
			result.Rejected = append(result.Rejected,
				RejectedMember{Member: removed, Reason: ErrConflictingName},
				RejectedMember{Member: member, Reason: ErrConflictingName},
			)
			delete(acceptedDigest, name)
			conflicted[name] = true
			rebuildIndex(acceptedIndex, result.Members)
			continue
		}

		acceptedIndex[name] = len(result.Members)
		acceptedDigest[name] = actualDigest
		result.Members = append(result.Members, member)
	}
}

// readMemberHeader 读取一条成员记录的头部。nameLen 为 0 时表示结束标记。
func readMemberHeader(r io.Reader) (name string, declaredSize int64, digest [sha256.Size]byte, err error) {
	var nameLenBuf [4]byte
	if _, err = io.ReadFull(r, nameLenBuf[:]); err != nil {
		return "", 0, digest, err
	}
	nameLen := binary.BigEndian.Uint32(nameLenBuf[:])
	if nameLen == 0 {
		return "", 0, digest, nil
	}
	if nameLen > maxNameLength {
		return "", 0, digest, fmt.Errorf("%w: 成员名称长度 %d 超出限制", ErrBadArchive, nameLen)
	}

	nameBuf := make([]byte, nameLen)
	if _, err = io.ReadFull(r, nameBuf); err != nil {
		return "", 0, digest, err
	}

	var sizeBuf [8]byte
	if _, err = io.ReadFull(r, sizeBuf[:]); err != nil {
		return "", 0, digest, err
	}
	declaredSize = int64(binary.BigEndian.Uint64(sizeBuf[:]))
	if declaredSize < 0 {
		return "", 0, digest, fmt.Errorf("%w: 成员 %q 声明字节数为负", ErrBadArchive, string(nameBuf))
	}

	if _, err = io.ReadFull(r, digest[:]); err != nil {
		return "", 0, digest, err
	}
	return string(nameBuf), declaredSize, digest, nil
}

// drainBody 跳过某条成员的正文，使流定位到下一条成员记录。
// 支持 Seek 时直接跳过，避免把超限或非法成员的正文读入内存。
func drainBody(r io.Reader, declaredSize int64) error {
	if declaredSize <= 0 {
		return nil
	}
	if seeker, ok := r.(io.Seeker); ok {
		if _, err := seeker.Seek(declaredSize, io.SeekCurrent); err == nil {
			return nil
		}
	}
	_, err := io.CopyN(io.Discard, r, declaredSize)
	return err
}

func removeMember(result *Result, index int) Member {
	removed := result.Members[index]
	result.Members = append(result.Members[:index], result.Members[index+1:]...)
	return removed
}

func rebuildIndex(index map[string]int, members []Member) {
	for i := range index {
		delete(index, i)
	}
	for i, member := range members {
		index[member.Name] = i
	}
}
