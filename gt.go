package dataeng

import (
	"fmt"
	"strconv"
	"strings"
)

// ConvertGT projects a GT string. It must contain exactly Ploidy fields, each
// either "." (missing) or a non-negative decimal integer without leading
// zeros, joined by '/' or '|' separators. Field order and every separator are
// preserved; dropped alleles become ".". GT fields are never reordered with
// the non-decreasing probability-tuple rule.
func (t *Transform) ConvertGT(gt string) (string, error) {
	if gt == "" {
		return "", fmt.Errorf("%w: empty GT string", ErrInvalidGT)
	}

	fields := make([]string, 0, t.Ploidy)
	separators := make([]byte, 0, t.Ploidy-1)
	current := strings.Builder{}
	for i := 0; i < len(gt); i++ {
		ch := gt[i]
		if ch == '/' || ch == '|' {
			fields = append(fields, current.String())
			separators = append(separators, ch)
			current.Reset()
			continue
		}
		current.WriteByte(ch)
	}
	fields = append(fields, current.String())

	if len(fields) != t.Ploidy {
		return "", fmt.Errorf("%w: GT %q has %d fields, ploidy is %d", ErrInvalidGT, gt, len(fields), t.Ploidy)
	}
	if len(separators) != t.Ploidy-1 {
		return "", fmt.Errorf("%w: GT %q has %d separators, want %d", ErrInvalidGT, gt, len(separators), t.Ploidy-1)
	}

	output := strings.Builder{}
	for i, field := range fields {
		if i > 0 {
			output.WriteByte(separators[i-1])
		}
		if field == "." {
			output.WriteString(".")
			continue
		}
		if !isCanonicalDecimal(field) {
			return "", fmt.Errorf("%w: GT field %q is not a canonical decimal integer or '.'", ErrInvalidGT, field)
		}
		allele, err := strconv.Atoi(field)
		if err != nil || allele < 0 || allele >= t.SourceAlleles {
			return "", fmt.Errorf("%w: GT field %q is outside source range [0,%d)", ErrInvalidGT, field, t.SourceAlleles)
		}
		target, retained := t.MapAllele(allele)
		if !retained {
			output.WriteString(".")
		} else {
			output.WriteString(strconv.Itoa(target))
		}
	}
	return output.String(), nil
}
