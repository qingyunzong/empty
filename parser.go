package dataeng

import (
	"fmt"
	"unicode/utf8"
)

type parser struct {
	data []byte
	pos  int
}

func parseMessage(payload []byte) (Message, error) {
	p := &parser{data: payload}

	if len(payload) == 0 {
		return Message{}, p.error("empty payload")
	}

	message := Message{Raw: append([]byte(nil), payload...)}
	if err := p.parsePRI(&message); err != nil {
		return Message{}, err
	}
	if err := p.expectSpace("after version"); err != nil {
		return Message{}, err
	}

	timestamp, err := p.parseTimestamp()
	if err != nil {
		return Message{}, err
	}
	message.Timestamp = timestamp
	if err := p.expectSpace("after timestamp"); err != nil {
		return Message{}, err
	}

	message.Host, err = p.parseField(255, "host")
	if err != nil {
		return Message{}, err
	}
	message.AppName, err = p.parseField(48, "app-name")
	if err != nil {
		return Message{}, err
	}
	message.ProcID, err = p.parseField(128, "procid")
	if err != nil {
		return Message{}, err
	}
	message.MsgID, err = p.parseField(32, "msgid")
	if err != nil {
		return Message{}, err
	}

	message.StructuredData, err = p.parseStructuredData()
	if err != nil {
		return Message{}, err
	}

	if p.pos < len(p.data) {
		if p.data[p.pos] != ' ' {
			return Message{}, p.error("expected end of payload or one space before message")
		}
		p.pos++
		message.HasMessage = true

		body := p.data[p.pos:]
		bodyOffset := p.pos
		if len(body) >= 3 && body[0] == 0xef && body[1] == 0xbb && body[2] == 0xbf {
			message.BOM = true
			body = body[3:]
			bodyOffset += 3
		}
		if err := validateText(body, bodyOffset, "message"); err != nil {
			return Message{}, err
		}
		message.Message = string(body)
		p.pos = len(p.data)
	}

	if p.pos != len(p.data) {
		return Message{}, p.error("trailing bytes")
	}
	return message, nil
}

func (p *parser) parsePRI(message *Message) error {
	if p.pos >= len(p.data) || p.data[p.pos] != '<' {
		return p.error("expected '<' before PRI")
	}
	p.pos++

	start := p.pos
	for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
		if p.pos-start == 3 {
			return p.error("PRI has more than 3 digits")
		}
		p.pos++
	}
	if p.pos == start {
		return p.error("PRI must contain 1 to 3 digits")
	}
	if p.data[start] == '0' && p.pos-start != 1 {
		return p.error("PRI has a leading zero")
	}

	value := 0
	for _, b := range p.data[start:p.pos] {
		value = value*10 + int(b-'0')
	}
	if value > 191 {
		return p.error("PRI exceeds 191")
	}
	if p.pos >= len(p.data) || p.data[p.pos] != '>' {
		return p.error("expected '>' after PRI")
	}
	p.pos++

	message.PRI = value
	message.Facility = value / 8
	message.Severity = value % 8

	if p.pos >= len(p.data) || p.data[p.pos] != '1' {
		return p.error("version must be the character 1")
	}
	message.Version = '1'
	p.pos++
	return nil
}

func (p *parser) parseTimestamp() (Timestamp, error) {
	start := p.pos
	if p.pos < len(p.data) && p.data[p.pos] == '-' {
		p.pos++
		return Timestamp{Raw: "-", Nil: true}, nil
	}
	if len(p.data)-p.pos < 19 {
		return Timestamp{}, p.error("timestamp is shorter than YYYY-MM-DDTHH:MM:SS")
	}

	year, ok := p.fixedDigits(4)
	if !ok {
		return Timestamp{}, p.error("timestamp year must have 4 digits")
	}
	if !p.take('-') {
		return Timestamp{}, p.error("timestamp expected '-' after year")
	}
	month, ok := p.fixedDigits(2)
	if !ok {
		return Timestamp{}, p.error("timestamp month must have 2 digits")
	}
	if !p.take('-') {
		return Timestamp{}, p.error("timestamp expected '-' after month")
	}
	day, ok := p.fixedDigits(2)
	if !ok {
		return Timestamp{}, p.error("timestamp day must have 2 digits")
	}
	if !p.take('T') {
		return Timestamp{}, p.error("timestamp expected 'T' after date")
	}
	hour, ok := p.fixedDigits(2)
	if !ok {
		return Timestamp{}, p.error("timestamp hour must have 2 digits")
	}
	if !p.take(':') {
		return Timestamp{}, p.error("timestamp expected ':' after hour")
	}
	minute, ok := p.fixedDigits(2)
	if !ok {
		return Timestamp{}, p.error("timestamp minute must have 2 digits")
	}
	if !p.take(':') {
		return Timestamp{}, p.error("timestamp expected ':' after minute")
	}
	second, ok := p.fixedDigits(2)
	if !ok {
		return Timestamp{}, p.error("timestamp second must have 2 digits")
	}

	if err := validDate(year, month, day); err != nil {
		return Timestamp{}, p.error(err.Error())
	}
	if hour > 23 {
		return Timestamp{}, p.error("timestamp hour must be between 0 and 23")
	}
	if minute > 59 {
		return Timestamp{}, p.error("timestamp minute must be between 0 and 59")
	}
	if second > 59 {
		return Timestamp{}, p.error("timestamp second must be between 0 and 59")
	}

	fraction := ""
	if p.pos < len(p.data) && p.data[p.pos] == '.' {
		p.pos++
		fractionStart := p.pos
		for p.pos < len(p.data) && p.data[p.pos] >= '0' && p.data[p.pos] <= '9' {
			if p.pos-fractionStart == 6 {
				return Timestamp{}, p.error("timestamp fraction has more than 6 digits")
			}
			p.pos++
		}
		if p.pos == fractionStart {
			return Timestamp{}, p.error("timestamp fraction must have 1 to 6 digits")
		}
		fraction = string(p.data[fractionStart:p.pos])
	}

	zone := ""
	switch {
	case p.pos < len(p.data) && p.data[p.pos] == 'Z':
		zone = "Z"
		p.pos++
	case p.pos < len(p.data) && (p.data[p.pos] == '+' || p.data[p.pos] == '-'):
		zoneStart := p.pos
		p.pos++
		zoneHour, ok := p.fixedDigits(2)
		if !ok {
			return Timestamp{}, p.error("timezone offset hour must have 2 digits")
		}
		if !p.take(':') {
			return Timestamp{}, p.error("timezone offset expected ':' after hour")
		}
		zoneMinute, ok := p.fixedDigits(2)
		if !ok {
			return Timestamp{}, p.error("timezone offset minute must have 2 digits")
		}
		if zoneHour > 23 {
			return Timestamp{}, p.error("timezone offset hour must be between 0 and 23")
		}
		if zoneMinute > 59 {
			return Timestamp{}, p.error("timezone offset minute must be between 0 and 59")
		}
		zone = string(p.data[zoneStart:p.pos])
	default:
		return Timestamp{}, p.error("timestamp must end with Z or a HH:MM offset")
	}

	return Timestamp{
		Raw:      string(p.data[start:p.pos]),
		Year:     year,
		Month:    month,
		Day:      day,
		Hour:     hour,
		Minute:   minute,
		Second:   second,
		Fraction: fraction,
		Zone:     zone,
	}, nil
}

func (p *parser) parseField(max int, name string) (string, error) {
	start := p.pos
	for {
		if p.pos >= len(p.data) {
			return "", p.error(name + " is not followed by a space")
		}
		b := p.data[p.pos]
		if b == ' ' {
			break
		}
		if b < 33 || b > 126 {
			return "", p.error(name + " contains a byte outside visible ASCII 33..126")
		}
		p.pos++
		if p.pos-start > max {
			return "", p.error(fmt.Sprintf("%s is longer than %d bytes", name, max))
		}
	}
	if p.pos == start {
		return "", p.error(name + " may only be empty as '-'")
	}

	value := string(p.data[start:p.pos])
	p.pos++
	if value == "-" {
		return "", nil
	}
	return value, nil
}

func (p *parser) parseStructuredData() ([]SDElement, error) {
	if p.pos >= len(p.data) {
		return nil, p.error("missing structured data")
	}
	if p.data[p.pos] == '-' {
		p.pos++
		return nil, nil
	}
	if p.data[p.pos] != '[' {
		return nil, p.error("structured data must be '-' or start with '['")
	}

	var elements []SDElement
	for p.pos < len(p.data) && p.data[p.pos] == '[' {
		element, err := p.parseSDElement()
		if err != nil {
			return nil, err
		}
		elements = append(elements, element)
	}
	return elements, nil
}

func (p *parser) parseSDElement() (SDElement, error) {
	p.pos++ // '['

	id, err := p.parseSDName("SD-ID")
	if err != nil {
		return SDElement{}, err
	}
	element := SDElement{ID: id}

	for {
		if p.pos >= len(p.data) {
			return SDElement{}, p.error("structured-data element has no closing ']'")
		}
		switch p.data[p.pos] {
		case ']':
			p.pos++
			return element, nil
		case ' ':
			p.pos++
			param, err := p.parseSDParam()
			if err != nil {
				return SDElement{}, err
			}
			element.Params = append(element.Params, param)
		default:
			return SDElement{}, p.error("expected one space or ']' in structured-data element")
		}
	}
}

func (p *parser) parseSDName(kind string) (string, error) {
	start := p.pos
	for {
		if p.pos >= len(p.data) {
			return "", p.error(kind + " is not terminated")
		}
		b := p.data[p.pos]
		if b == '=' || b == ' ' || b == ']' || b == '"' {
			break
		}
		if b < 33 || b > 126 {
			return "", p.error(kind + " contains a byte outside visible ASCII 33..126")
		}
		p.pos++
		if p.pos-start > 32 {
			return "", p.error(fmt.Sprintf("%s is longer than 32 bytes", kind))
		}
	}
	if p.pos == start {
		return "", p.error(kind + " must have 1 to 32 bytes")
	}
	return string(p.data[start:p.pos]), nil
}

func (p *parser) parseSDParam() (SDParam, error) {
	name, err := p.parseSDName("parameter name")
	if err != nil {
		return SDParam{}, err
	}
	if p.pos >= len(p.data) || p.data[p.pos] != '=' {
		return SDParam{}, p.error("parameter name must be followed by '='")
	}
	p.pos++
	if p.pos >= len(p.data) || p.data[p.pos] != '"' {
		return SDParam{}, p.error("parameter value must start with '\"'")
	}
	p.pos++

	valueStart := p.pos
	var value []byte
	for {
		if p.pos >= len(p.data) {
			return SDParam{}, p.error("parameter value has no closing '\"'")
		}
		switch p.data[p.pos] {
		case '"':
			p.pos++
			if err := validateText(value, valueStart, "parameter value"); err != nil {
				return SDParam{}, err
			}
			return SDParam{Name: name, Value: string(value)}, nil
		case '\\':
			if p.pos+1 >= len(p.data) {
				return SDParam{}, p.error("parameter value ends with a backslash")
			}
			switch p.data[p.pos+1] {
			case '\\':
				value = append(value, '\\')
			case '"':
				value = append(value, '"')
			case ']':
				value = append(value, ']')
			default:
				return SDParam{}, p.error("parameter value contains an unsupported escape")
			}
			p.pos += 2
		case ']':
			return SDParam{}, p.error("parameter value must escape ']'")
		default:
			value = append(value, p.data[p.pos])
			p.pos++
		}
	}
}

func (p *parser) fixedDigits(n int) (int, bool) {
	if len(p.data)-p.pos < n {
		return 0, false
	}
	value := 0
	for i := 0; i < n; i++ {
		b := p.data[p.pos+i]
		if b < '0' || b > '9' {
			return 0, false
		}
		value = value*10 + int(b-'0')
	}
	p.pos += n
	return value, true
}

func (p *parser) take(want byte) bool {
	if p.pos >= len(p.data) || p.data[p.pos] != want {
		return false
	}
	p.pos++
	return true
}

func (p *parser) expectSpace(after string) error {
	if p.pos >= len(p.data) || p.data[p.pos] != ' ' {
		return p.error("expected one space " + after)
	}
	p.pos++
	return nil
}

func (p *parser) error(reason string) error {
	return &ParseError{Offset: p.pos, Reason: reason}
}

func validDate(year, month, day int) error {
	if month < 1 || month > 12 {
		return fmt.Errorf("timestamp month is outside 1..12")
	}
	days := [...]int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	maxDay := days[month-1]
	if month == 2 && leapYear(year) {
		maxDay = 29
	}
	if day < 1 || day > maxDay {
		return fmt.Errorf("timestamp day is invalid for that month")
	}
	return nil
}

func leapYear(year int) bool {
	return year%4 == 0 && (year%100 != 0 || year%400 == 0)
}

func validateText(text []byte, offset int, kind string) error {
	if !utf8.Valid(text) {
		return &ParseError{Offset: offset, Reason: kind + " is not valid UTF-8"}
	}
	for i, b := range text {
		if b < 0x20 {
			return &ParseError{Offset: offset + i, Reason: kind + " contains a control byte 0..31"}
		}
	}
	return nil
}
