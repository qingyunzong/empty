package logparse

import "regexp"

// DefaultRules 返回内置的有限规则表：
//   - timestamp：以 ISO 风格时间戳开头的行作为起始行；
//   - level：以 [INFO] 这类级别标记开头的行作为起始行；
//   - 两类记录均以空白缩进行作为续行（如堆栈、多行消息）。
func DefaultRules() []Rule {
	cont := regexp.MustCompile(`^[ \t]`)
	return []Rule{
		{
			Name:         "timestamp",
			Start:        regexp.MustCompile(`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}`),
			Continuation: cont,
		},
		{
			Name:         "level",
			Start:        regexp.MustCompile(`^\[(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\]`),
			Continuation: cont,
		},
	}
}
