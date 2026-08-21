package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Work memo status constants.
const (
	WorkMemoStatusNormal    = "normal"
	WorkMemoStatusPending   = "pending"
	WorkMemoStatusCompleted = "completed"
)

// ErrInvalidReorder is returned when a reorder request does not exactly match
// the current set of work memos for the owner and date.
var ErrInvalidReorder = errors.New("invalid reorder request")

// WorkMemo represents a single work memo entry for a given day.
// Unlike Diary, multiple work memos can exist for the same owner and date.
type WorkMemo struct {
	ID       string   `json:"id"`
	Owner    string   `json:"owner"`
	Date     string   `json:"date"`
	Content  string   `json:"content"`
	Status   string   `json:"status"`
	IsPinned bool     `json:"is_pinned"`
	Position int      `json:"position"`
	Tags     []string `json:"tags"`
	Created  string   `json:"created"`
	Updated  string   `json:"updated"`
}

// CreateWorkMemoInput contains the fields required to create a work memo.
// The new memo is always appended to the end of the specified day by the
// store layer; callers cannot specify a position.
type CreateWorkMemoInput struct {
	Date     string
	Content  string
	Status   string
	IsPinned bool
	Tags     []string
}

// UpdateWorkMemoInput contains optional fields for a partial update.
// A nil pointer means the field should not be changed. Position is not
// exposed here; reordering must use ReorderWorkMemos.
type UpdateWorkMemoInput struct {
	Content  *string
	Date     *string
	Status   *string
	IsPinned *bool
	Tags     *[]string
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

// normalizeWorkMemoDate validates a YYYY-MM-DD date and returns the internal
// storage format used by Diarum: "YYYY-MM-DD 00:00:00.000Z".
func normalizeWorkMemoDate(date string) (string, error) {
	if date == "" {
		return "", fmt.Errorf("date is required")
	}
	if _, err := time.Parse("2006-01-02", date); err != nil {
		return "", fmt.Errorf("invalid date %q: %w", date, err)
	}
	return date + " 00:00:00.000Z", nil
}

// IsValidWorkMemoStatus reports whether s is a supported work memo status.
func IsValidWorkMemoStatus(s string) bool {
	switch s {
	case WorkMemoStatusNormal, WorkMemoStatusPending, WorkMemoStatusCompleted:
		return true
	default:
		return false
	}
}

// FormatWorkMemoDateAPI converts the internal storage date back to the API
// date-only format YYYY-MM-DD.
func FormatWorkMemoDateAPI(date string) string {
	if len(date) >= 10 {
		return date[:10]
	}
	return date
}

// createMemoTags normalizes a nil slice to an empty slice so that the database
// always stores a JSON array ("[]") instead of JSON null.
func createMemoTags(tags []string) []string {
	if tags == nil {
		return []string{}
	}
	return tags
}

// CreateWorkMemo creates a new work memo. The memo is always appended to the
// end of the specified day using an atomic subquery.
func (s *Store) CreateWorkMemo(owner string, input CreateWorkMemoInput) (*WorkMemo, error) {
	if owner == "" {
		return nil, fmt.Errorf("owner is required")
	}
	fullDate, err := normalizeWorkMemoDate(input.Date)
	if err != nil {
		return nil, err
	}

	status := input.Status
	if status == "" {
		status = WorkMemoStatusNormal
	}
	if !IsValidWorkMemoStatus(status) {
		return nil, fmt.Errorf("invalid status: %s", status)
	}

	tags := createMemoTags(input.Tags)

	id, err := GenerateID()
	if err != nil {
		return nil, err
	}
	now := nowString()

	_, err = s.DB.Exec(
		`INSERT INTO work_memos(id, owner, date, content, status, is_pinned, position, tags, created, updated)
		VALUES(?, ?, ?, ?, ?, ?, COALESCE((SELECT MAX(position) + 1 FROM work_memos WHERE owner = ? AND date = ?), 0), ?, ?, ?)`,
		id, owner, fullDate, input.Content, status, boolToInt(input.IsPinned), owner, fullDate, encodeJSON(tags), now, now,
	)
	if err != nil {
		return nil, err
	}
	return s.GetWorkMemo(id, owner)
}

// GetWorkMemo fetches a work memo by id. If owner is non-empty, the record is
// verified to belong to that owner.
func (s *Store) GetWorkMemo(id, owner string) (*WorkMemo, error) {
	memo, err := scanWorkMemo(s.DB.QueryRow(`SELECT id, owner, date, content, status, is_pinned, position, tags, created, updated FROM work_memos WHERE id = ?`, id))
	if err != nil {
		return nil, err
	}
	if owner != "" && memo.Owner != owner {
		return nil, sql.ErrNoRows
	}
	return memo, nil
}

// ListWorkMemosByDate returns every work memo for an owner on a specific date,
// sorted by pinned first, then by position, then by creation time.
func (s *Store) ListWorkMemosByDate(owner, date string) ([]*WorkMemo, error) {
	fullDate, err := normalizeWorkMemoDate(date)
	if err != nil {
		return nil, err
	}
	rows, err := s.DB.Query(
		`SELECT id, owner, date, content, status, is_pinned, position, tags, created, updated FROM work_memos WHERE owner = ? AND date = ? ORDER BY is_pinned DESC, position ASC, created ASC`,
		owner, fullDate,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanWorkMemos(rows)
}

// UpdateWorkMemo applies a partial update to an existing work memo. Ownership is
// verified via the owner argument. Only fields present in input are written;
// unprovided fields keep their current values. When the date changes, the memo
// is automatically appended to the end of the target day. Position can only be
// changed through ReorderWorkMemos.
func (s *Store) UpdateWorkMemo(owner, id string, input UpdateWorkMemoInput) (*WorkMemo, error) {
	if owner == "" {
		return nil, fmt.Errorf("owner is required")
	}
	existing, err := s.GetWorkMemo(id, owner)
	if err != nil {
		return nil, err
	}

	setParts := []string{"updated = ?"}
	args := []any{nowString()}

	if input.Content != nil {
		setParts = append(setParts, "content = ?")
		args = append(args, *input.Content)
	}
	if input.Status != nil {
		if !IsValidWorkMemoStatus(*input.Status) {
			return nil, fmt.Errorf("invalid status: %s", *input.Status)
		}
		setParts = append(setParts, "status = ?")
		args = append(args, *input.Status)
	}
	if input.IsPinned != nil {
		setParts = append(setParts, "is_pinned = ?")
		args = append(args, boolToInt(*input.IsPinned))
	}
	if input.Tags != nil {
		tags := createMemoTags(*input.Tags)
		setParts = append(setParts, "tags = ?")
		args = append(args, encodeJSON(tags))
	}

	if input.Date != nil {
		newDate, err := normalizeWorkMemoDate(*input.Date)
		if err != nil {
			return nil, err
		}
		if newDate != existing.Date {
			setParts = append(setParts, "date = ?")
			args = append(args, newDate)
			// When moving across dates, always append to the end of the target day.
			setParts = append(setParts, "position = COALESCE((SELECT MAX(position) + 1 FROM work_memos WHERE owner = ? AND date = ?), 0)")
			args = append(args, owner, newDate)
		}
	}

	args = append(args, id, owner)
	query := "UPDATE work_memos SET " + strings.Join(setParts, ", ") + " WHERE id = ? AND owner = ?"
	_, err = s.DB.Exec(query, args...)
	if err != nil {
		return nil, err
	}
	return s.GetWorkMemo(id, owner)
}

// DeleteWorkMemo removes a work memo. Only the owner can delete it.
func (s *Store) DeleteWorkMemo(id, owner string) error {
	result, err := s.DB.Exec(`DELETE FROM work_memos WHERE id = ? AND owner = ?`, id, owner)
	if err != nil {
		return err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

// ReorderWorkMemos assigns sequential positions to the given ids for a specific
// date. The order of ids in the slice becomes the new order. The request must
// exactly match the current set of work memo ids for the owner and date:
// no duplicates, no omissions, no extra ids, no ids from other dates or owners.
func (s *Store) ReorderWorkMemos(owner, date string, ids []string) error {
	fullDate, err := normalizeWorkMemoDate(date)
	if err != nil {
		return err
	}
	return s.Transaction(context.Background(), func(tx *sql.Tx) error {
		rows, err := tx.Query(`SELECT id FROM work_memos WHERE owner = ? AND date = ?`, owner, fullDate)
		if err != nil {
			return err
		}
		existing := make(map[string]struct{})
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			existing[id] = struct{}{}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}

		if len(ids) != len(existing) {
			return ErrInvalidReorder
		}

		seen := make(map[string]struct{})
		for _, id := range ids {
			if _, ok := seen[id]; ok {
				return ErrInvalidReorder
			}
			seen[id] = struct{}{}
			if _, ok := existing[id]; !ok {
				return ErrInvalidReorder
			}
		}

		for idx, id := range ids {
			_, err := tx.Exec(
				`UPDATE work_memos SET position = ?, updated = ? WHERE id = ? AND owner = ? AND date = ?`,
				idx, nowString(), id, owner, fullDate,
			)
			if err != nil {
				return err
			}
		}
		return nil
	})
}

func scanWorkMemo(row interface{ Scan(dest ...any) error }) (*WorkMemo, error) {
	var tagsRaw string
	var isPinnedInt int
	memo := &WorkMemo{}
	err := row.Scan(&memo.ID, &memo.Owner, &memo.Date, &memo.Content, &memo.Status, &isPinnedInt, &memo.Position, &tagsRaw, &memo.Created, &memo.Updated)
	if err != nil {
		return nil, err
	}
	memo.IsPinned = isPinnedInt != 0
	memo.Tags = decodeStringSlice(tagsRaw)
	return memo, nil
}

func scanWorkMemos(rows *sql.Rows) ([]*WorkMemo, error) {
	items := make([]*WorkMemo, 0)
	for rows.Next() {
		item, err := scanWorkMemo(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}
