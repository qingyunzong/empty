package dataeng

import (
	"archive/tar"
	"bytes"
	"fmt"
	"io"
	"math"
	"time"
)

var (
	magicGNU     = []byte("ustar ")
	versionGNU   = []byte(" \x00")
	magicUSTAR   = []byte("ustar\x00")
	versionUSTAR = []byte("00")
	trailerSTAR  = []byte("tar\x00")
)

// parseRawHeader decodes one 512-byte tar header block.
func parseRawHeader(block []byte) (*tar.Header, tar.Format, error) {
	if len(block) != blockSize {
		return nil, tar.FormatUnknown, fmt.Errorf("%w: short tar header", ErrHeader)
	}

	magic := block[257:263]
	version := block[263:265]
	trailer := block[508:512]

	format := tar.FormatUnknown
	switch {
	case bytes.Equal(magic, magicGNU) && bytes.Equal(version, versionGNU):
		format = tar.FormatGNU
	case bytes.Equal(magic, magicUSTAR) && bytes.Equal(trailer, trailerSTAR):
		format = tar.FormatUnknown // STAR; sparse type S has a different layout.
	case bytes.Equal(magic, magicUSTAR):
		format = tar.FormatUSTAR
	}

	size, err := parseNumeric(block[124:136])
	if err != nil {
		return nil, format, err
	}
	if size < 0 {
		return nil, format, fmt.Errorf("%w: negative entry size", ErrHeader)
	}
	mode, err := parseNumeric(block[100:108])
	if err != nil {
		return nil, format, err
	}
	uid, err := parseNumeric(block[108:116])
	if err != nil {
		return nil, format, err
	}
	gid, err := parseNumeric(block[116:124])
	if err != nil {
		return nil, format, err
	}
	modTime, err := parseNumeric(block[136:148])
	if err != nil {
		return nil, format, err
	}
	devMajor, err := parseNumeric(block[329:337])
	if err != nil {
		return nil, format, err
	}
	devMinor, err := parseNumeric(block[337:345])
	if err != nil {
		return nil, format, err
	}
	storedChecksum, err := parseNumeric(block[148:156])
	if err != nil {
		return nil, format, err
	}
	if storedChecksum != 0 {
		unsigned, signed := headerChecksums(block)
		if storedChecksum != unsigned && storedChecksum != signed {
			return nil, format, fmt.Errorf("%w: header checksum mismatch", ErrHeader)
		}
	}

	header := &tar.Header{
		Name:     cString(block[0:100]),
		Mode:     mode,
		Uid:      int(uid),
		Gid:      int(gid),
		Size:     size,
		ModTime:  time.Unix(modTime, 0),
		Typeflag: block[156],
		Linkname: cString(block[157:257]),
		Uname:    cString(block[265:297]),
		Gname:    cString(block[297:329]),
		Devmajor: devMajor,
		Devminor: devMinor,
		Format:   format,
	}
	if header.Uid < 0 || int64(header.Uid) != uid {
		return nil, format, fmt.Errorf("%w: uid out of range", ErrHeader)
	}
	if header.Gid < 0 || int64(header.Gid) != gid {
		return nil, format, fmt.Errorf("%w: gid out of range", ErrHeader)
	}

	if format == tar.FormatUSTAR {
		prefix := cString(block[345:500])
		if prefix != "" {
			header.Name = prefix + "/" + header.Name
		}
	}

	if header.Typeflag == tar.TypeRegA {
		if len(header.Name) > 0 && header.Name[len(header.Name)-1] == '/' {
			header.Typeflag = tar.TypeDir
		} else {
			header.Typeflag = tar.TypeReg
		}
	}

	return header, format, nil
}

func headerChecksums(block []byte) (unsigned, signed int64) {
	for index, b := range block {
		if index >= 148 && index < 156 {
			b = ' '
		}
		unsigned += int64(b)
		signed += int64(int8(b))
	}
	return unsigned, signed
}

func cString(field []byte) string {
	if index := bytes.IndexByte(field, 0); index >= 0 {
		field = field[:index]
	}
	return string(field)
}

// parseNumeric decodes a tar numeric field. Both the traditional octal form
// and GNU's base-256 encoding are supported.
func parseNumeric(field []byte) (int64, error) {
	if len(field) == 0 {
		return 0, nil
	}

	if field[0]&0x80 != 0 {
		var inverse byte
		if field[0]&0x40 != 0 {
			inverse = 0xff
		}
		var value uint64
		for index, b := range field {
			b ^= inverse
			if index == 0 {
				b &= 0x7f
			}
			if value>>56 != 0 {
				return 0, fmt.Errorf("%w: numeric field overflows", ErrHeader)
			}
			value = value<<8 | uint64(b)
		}
		if value>>63 != 0 {
			return 0, fmt.Errorf("%w: numeric field overflows", ErrHeader)
		}
		if inverse == 0xff {
			return ^int64(value), nil
		}
		return int64(value), nil
	}

	field = bytes.Trim(field, " \x00")
	if len(field) == 0 {
		return 0, nil
	}
	var value uint64
	for _, b := range field {
		if b < '0' || b > '7' {
			return 0, fmt.Errorf("%w: invalid octal field %q", ErrHeader, field)
		}
		if value > (math.MaxUint64-uint64(b-'0'))/8 {
			return 0, fmt.Errorf("%w: numeric field overflows", ErrHeader)
		}
		value = value*8 + uint64(b-'0')
	}
	if value > math.MaxInt64 {
		return 0, fmt.Errorf("%w: numeric field overflows", ErrHeader)
	}
	return int64(value), nil
}

func isZeroBlock(block []byte) bool {
	for _, b := range block {
		if b != 0 {
			return false
		}
	}
	return true
}

// readOldGNUSparseMap reads the four sparse entries in a legacy GNU header and
// follows any chained extension headers. The extension blocks are consumed
// directly from r and are not part of the entry body (Header.Size).
func readOldGNUSparseMap(block []byte, r io.Reader) ([]Extent, int64, error) {
	if len(block) != blockSize {
		return nil, 0, fmt.Errorf("%w: short GNU header", ErrHeader)
	}
	logicalSize, err := parseNumeric(block[483:495])
	if err != nil {
		return nil, 0, err
	}
	if logicalSize < 0 {
		return nil, 0, fmt.Errorf("%w: negative GNU real size", ErrHeader)
	}

	extents := make([]Extent, 0, 4)
	addEntry := func(field []byte) (bool, error) {
		if field[0] == 0 {
			return false, nil
		}
		offset, err := parseNumeric(field[0:12])
		if err != nil {
			return false, err
		}
		length, err := parseNumeric(field[12:24])
		if err != nil {
			return false, err
		}
		extents = append(extents, Extent{Offset: offset, Length: length})
		if len(extents) > maxSparseFileEntries {
			return false, ErrSparseMapTooLong
		}
		return true, nil
	}

	for index := 0; index < 4; index++ {
		keepGoing, err := addEntry(block[386+index*24 : 386+(index+1)*24])
		if err != nil {
			return nil, 0, err
		}
		if !keepGoing {
			break
		}
	}

	extended := block[482] != 0
	if extended && r == nil {
		return nil, 0, fmt.Errorf("%w: missing GNU sparse extension reader", ErrHeader)
	}
	var extension [blockSize]byte
	for extensionCount := 0; extended; extensionCount++ {
		if extensionCount*blockSize >= maxSpecialFileSize {
			return nil, 0, ErrSparseMapTooLong
		}
		if _, err := io.ReadFull(r, extension[:]); err != nil {
			if err == io.EOF {
				err = io.ErrUnexpectedEOF
			}
			return nil, 0, err
		}
		for index := 0; index < 21; index++ {
			keepGoing, err := addEntry(extension[index*24 : (index+1)*24])
			if err != nil {
				return nil, 0, err
			}
			if !keepGoing {
				break
			}
		}
		extended = extension[504] != 0
	}

	if err := ValidateExtents(extents, logicalSize); err != nil {
		return nil, 0, err
	}
	return extents, logicalSize, nil
}

// ParseOldGNUSparseMap parses a legacy GNU type-S header block. If the header
// has chained extension headers, extension must provide them immediately after
// the block, as they appear in the archive. The returned map has the logical
// file size and compact data size filled in.
func ParseOldGNUSparseMap(block []byte, extension io.Reader) (*SparseMap, error) {
	extents, logicalSize, err := readOldGNUSparseMap(block, extension)
	if err != nil {
		return nil, err
	}
	return &SparseMap{
		LogicalSize: logicalSize,
		Size:        logicalSize,
		Extents:     extents,
		CompactSize: sumExtentLengths(extents),
	}, nil
}

// ParseLegacySparseHeader is an alias for ParseOldGNUSparseMap.
func ParseLegacySparseHeader(block []byte, extension io.Reader) (*SparseMap, error) {
	return ParseOldGNUSparseMap(block, extension)
}
