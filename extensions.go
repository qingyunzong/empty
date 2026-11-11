package q270

import "fmt"

// be16 decodes a big-endian uint16; callers ensure at least two bytes remain.
func be16(b []byte) uint16 {
	return uint16(b[0])<<8 | uint16(b[1])
}

// parseExtensions walks the extension block, rejecting duplicate extension
// types and any entry whose declared length escapes the block.
func parseExtensions(block []byte, info *ClientHelloInfo) error {
	seen := make(map[uint16]bool)
	p := 0
	for p < len(block) {
		if p+4 > len(block) {
			return fmt.Errorf("%w: extension header", ErrLengthOutOfBounds)
		}
		extType := be16(block[p:])
		extLen := int(be16(block[p+2:]))
		p += 4
		if p+extLen > len(block) {
			return fmt.Errorf("%w: extension type %d data", ErrLengthOutOfBounds, extType)
		}
		if seen[extType] {
			return fmt.Errorf("%w: type %d", ErrDuplicateExtension, extType)
		}
		seen[extType] = true

		data := block[p : p+extLen]
		switch extType {
		case extServerName:
			host, err := parseServerName(data)
			if err != nil {
				return err
			}
			info.ServerName = host
		case extALPN:
			protos, err := parseALPN(data)
			if err != nil {
				return err
			}
			info.ALPN = protos
		}
		p += extLen
	}
	return nil
}

// parseServerName extracts the unique host_name from an SNI extension.
// Unknown name types are skipped per RFC 6066; more than one host_name is
// rejected because the routing contract requires a unique host.
func parseServerName(data []byte) (string, error) {
	if len(data) < 2 {
		return "", fmt.Errorf("%w: server_name list length", ErrLengthOutOfBounds)
	}
	listLen := int(be16(data))
	if listLen == 0 || 2+listLen != len(data) {
		return "", fmt.Errorf("%w: server_name list", ErrLengthOutOfBounds)
	}
	end := 2 + listLen
	p := 2
	host := ""
	hostCount := 0
	for p < end {
		if p+3 > end {
			return "", fmt.Errorf("%w: server_name entry header", ErrLengthOutOfBounds)
		}
		nameType := data[p]
		nameLen := int(data[p+1])<<8 | int(data[p+2])
		p += 3
		if p+nameLen > end {
			return "", fmt.Errorf("%w: server_name entry", ErrLengthOutOfBounds)
		}
		name := data[p : p+nameLen]
		p += nameLen
		if nameType == sniHostName {
			if nameLen == 0 {
				return "", fmt.Errorf("%w: empty host_name", ErrInvalidClientHello)
			}
			hostCount++
			if hostCount > 1 {
				return "", fmt.Errorf("%w: multiple host_name entries", ErrInvalidClientHello)
			}
			host = string(name)
		}
	}
	return host, nil
}

// parseALPN extracts the protocol name list from an ALPN extension, rejecting
// empty protocol names and any length mismatch.
func parseALPN(data []byte) ([]string, error) {
	if len(data) < 2 {
		return nil, fmt.Errorf("%w: alpn list length", ErrLengthOutOfBounds)
	}
	listLen := int(be16(data))
	if listLen == 0 || 2+listLen != len(data) {
		return nil, fmt.Errorf("%w: alpn list", ErrLengthOutOfBounds)
	}
	end := 2 + listLen
	p := 2
	protos := make([]string, 0)
	for p < end {
		if p+1 > end {
			return nil, fmt.Errorf("%w: alpn entry length", ErrLengthOutOfBounds)
		}
		nameLen := int(data[p])
		p++
		if nameLen == 0 {
			return nil, fmt.Errorf("%w: empty alpn protocol", ErrInvalidClientHello)
		}
		if p+nameLen > end {
			return nil, fmt.Errorf("%w: alpn entry", ErrLengthOutOfBounds)
		}
		protos = append(protos, string(data[p:p+nameLen]))
		p += nameLen
	}
	return protos, nil
}
