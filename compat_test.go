package dataeng

import (
	encsv "encoding/csv"
	"reflect"
	"strings"
	"testing"
)

func TestMatchesEncodingCSVValues(t *testing.T) {
	inputs := []string{
		"a,b,c\n",
		"a,b,c\n1,2,3\n",
		"a,\"b\nc\",d\n",
		"a,\"b\"\"c\",d\n",
		"a,\"\",c\n",
		"\"a\",b\n",
		"a,b,\n",
		",b,c\n",
		"a,b\r\nc,d\r\n",
		"a,\"b\r\nc\",d\r\n",
		"a, b ,c\n",
	}
	for _, input := range inputs {
		stdReader := encsv.NewReader(strings.NewReader(input))
		stdReader.FieldsPerRecord = -1
		std, err := stdReader.ReadAll()
		if err != nil {
			t.Fatalf("encoding/csv %q: %v", input, err)
		}

		records := mustParse(t, input)
		got := values(records)
		if !reflect.DeepEqual(got, std) {
			t.Fatalf("input %q:\n got %#v\nstd %#v", input, got, std)
		}
	}
}
