package formal

import (
	"encoding/base64"
	"fmt"
	"strconv"
	"strings"
)

const saltedKeyPrefix = "~s1:"

// SaltKey returns an injective, reversible salted representation of key. The
// result is safe for arbitrary byte strings, including keys containing the
// separator characters used by the encoding.
func SaltKey(key string, salt uint32) string {
	return saltedKeyPrefix +
		strconv.FormatUint(uint64(salt), 10) + ":" +
		base64.RawURLEncoding.EncodeToString([]byte(key))
}

// RestoreSaltedKey reverses SaltKey.
func RestoreSaltedKey(s string) (key string, salt uint32, ok bool) {
	if !strings.HasPrefix(s, saltedKeyPrefix) {
		return "", 0, false
	}
	rest := strings.TrimPrefix(s, saltedKeyPrefix)
	parts := strings.SplitN(rest, ":", 2)
	if len(parts) != 2 {
		return "", 0, false
	}
	n, err := strconv.ParseUint(parts[0], 10, 32)
	if err != nil {
		return "", 0, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return "", 0, false
	}
	return string(raw), uint32(n), true
}

// EncodeSaltedKey is an alias for SaltKey.
func EncodeSaltedKey(key string, salt uint32) string {
	return SaltKey(key, salt)
}

// DecodeSaltedKey is an alias for RestoreSaltedKey.
func DecodeSaltedKey(s string) (key string, salt uint32, ok bool) {
	return RestoreSaltedKey(s)
}

// RestoreKey is an alias for RestoreSaltedKey.
func RestoreKey(s string) (key string, salt uint32, ok bool) {
	return RestoreSaltedKey(s)
}

// OriginalKey returns the unsalted key retained by the route.
func (r Route) OriginalKey() string {
	return r.Key
}

// SaltedKey returns the encoded key for a salted route. For an unsalted route
// it returns the original key unchanged.
func (r Route) SaltedKey() string {
	if !r.Salted {
		return r.Key
	}
	return SaltKey(r.Key, r.Salt)
}

// Restore checks that a salted representation belongs to this route and
// returns the original key and salt.
func (r Route) Restore(salted string) (string, uint32, bool) {
	key, salt, ok := RestoreSaltedKey(salted)
	if !ok || !r.Salted || key != r.Key || salt != r.Salt {
		return "", 0, false
	}
	return key, salt, true
}

func saltLabel(salt uint32) string {
	return fmt.Sprintf("%d", salt)
}
