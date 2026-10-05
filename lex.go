// Package bracketdiag 提供源码括号诊断：词法分析时忽略字符串与注释中的
// 括号，维护括号匹配对及未配对位置，并支持编辑后的增量更新。
package bracketdiag

// State 是行首（或行尾）的词法状态。编辑可能改变后续行的起始状态，
// 因此增量更新以 State 作为行与行之间的同步点。
type State int

const (
	StateNormal State = iota
	StateLineComment
	StateBlockComment
	StateString
	StateChar
	StateRawString
)

// BracketKind 区分三种括号。
type BracketKind int

const (
	Paren  BracketKind = iota // ()
	Square                    // []
	Brace                     // {}
)

// Token 是一个位于字符串/注释之外的括号。
type Token struct {
	Pos  int // 字节偏移
	Open bool
	Kind BracketKind
}

func openKind(c byte) (BracketKind, bool) {
	switch c {
	case '(':
		return Paren, true
	case '[':
		return Square, true
	case '{':
		return Brace, true
	}
	return 0, false
}

func closeKind(c byte) (BracketKind, bool) {
	switch c {
	case ')':
		return Paren, true
	case ']':
		return Square, true
	case '}':
		return Brace, true
	}
	return 0, false
}

// lexLine 扫描一行（不含换行符），st 为行首词法状态。
// 返回行内括号 token（Pos 为相对行首的偏移）及行尾状态。
// 行尾恢复规则：行注释、未闭合的字符串/字符字面量在行尾结束（回到
// StateNormal）；块注释与反引号原始字符串可跨行，状态延续到下一行。
func lexLine(line string, st State) ([]Token, State) {
	var toks []Token
	i := 0
	for i < len(line) {
		c := line[i]
		switch st {
		case StateNormal:
			if k, ok := openKind(c); ok {
				toks = append(toks, Token{Pos: i, Open: true, Kind: k})
				i++
				continue
			}
			if k, ok := closeKind(c); ok {
				toks = append(toks, Token{Pos: i, Open: false, Kind: k})
				i++
				continue
			}
			switch c {
			case '/':
				if i+1 < len(line) && line[i+1] == '/' {
					st = StateLineComment
					i += 2
				} else if i+1 < len(line) && line[i+1] == '*' {
					st = StateBlockComment
					i += 2
				} else {
					i++
				}
			case '"':
				st = StateString
				i++
			case '\'':
				st = StateChar
				i++
			case '`':
				st = StateRawString
				i++
			default:
				i++
			}
		case StateLineComment:
			i = len(line)
		case StateBlockComment:
			if c == '*' && i+1 < len(line) && line[i+1] == '/' {
				st = StateNormal
				i += 2
			} else {
				i++
			}
		case StateString:
			if c == '\\' {
				i += 2
			} else if c == '"' {
				st = StateNormal
				i++
			} else {
				i++
			}
		case StateChar:
			if c == '\\' {
				i += 2
			} else if c == '\'' {
				st = StateNormal
				i++
			} else {
				i++
			}
		case StateRawString:
			if c == '`' {
				st = StateNormal
			}
			i++
		}
	}
	switch st {
	case StateLineComment, StateString, StateChar:
		st = StateNormal
	}
	return toks, st
}
