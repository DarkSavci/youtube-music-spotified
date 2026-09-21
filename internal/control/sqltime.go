package control

import (
	"fmt"
	"time"
)

// sqlTime scans a timestamp that may arrive as either a time.Time or as text.
//
// SQLite has no native date type: values are stored with a declared column
// affinity the driver can honour on a direct read, but an aggregate such as
// MAX(played_at) erases that affinity and hands back the raw string. Scanning
// straight into a time.Time therefore works for column reads and fails for
// every aggregate — so all timestamp scans go through this instead.
type sqlTime struct {
	Time  time.Time
	Valid bool
}

// Layouts the driver may produce, most specific first.
var timeLayouts = []string{
	"2006-01-02 15:04:05.999999999 -0700 MST",
	"2006-01-02 15:04:05.999999999-07:00",
	time.RFC3339Nano,
	time.RFC3339,
	"2006-01-02 15:04:05.999999999",
	"2006-01-02 15:04:05",
}

func (t *sqlTime) Scan(src any) error {
	switch v := src.(type) {
	case nil:
		t.Time, t.Valid = time.Time{}, false
		return nil
	case time.Time:
		t.Time, t.Valid = v, true
		return nil
	case []byte:
		return t.parse(string(v))
	case string:
		return t.parse(v)
	default:
		return fmt.Errorf("control: cannot scan %T as time", src)
	}
}

func (t *sqlTime) parse(s string) error {
	if s == "" {
		t.Valid = false
		return nil
	}
	for _, layout := range timeLayouts {
		if parsed, err := time.Parse(layout, s); err == nil {
			t.Time, t.Valid = parsed.UTC(), true
			return nil
		}
	}
	return fmt.Errorf("control: unrecognised time %q", s)
}
