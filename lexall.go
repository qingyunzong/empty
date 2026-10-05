package streamlex

// LexAll 是全串（非流式）参照实现：一次性拿到完整输入，
// 在每个位置做最长匹配、同长按声明顺序取先，用于与流式实现对照。
// 出错时返回已切出的 token 与 *Error。
func LexAll(rules []Rule, src []byte) ([]Token, error) {
	var toks []Token
	pos := 0
	for pos < len(src) {
		bestLen, bestRule := -1, -1
		for i := range rules {
			st := rules[i].Start
			for k := pos; k < len(src); k++ {
				next, ok := rules[i].Trans[st][src[k]]
				if !ok {
					break
				}
				st = next
				// 规则按声明顺序枚举，仅严格更长才替换，
				// 故同长时保留声明在前的规则。
				if rules[i].Accept[st] && k-pos+1 > bestLen {
					bestLen, bestRule = k-pos+1, i
				}
			}
		}
		if bestLen < 0 {
			return toks, &Error{Offset: pos}
		}
		toks = append(toks, Token{
			Rule: bestRule,
			Name: rules[bestRule].Name,
			Pos:  pos,
			Text: string(src[pos : pos+bestLen]),
		})
		pos += bestLen
	}
	return toks, nil
}
