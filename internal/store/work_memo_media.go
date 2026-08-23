package store

import (
	"database/sql"
	"fmt"
)

// WorkMemoMedia associates an existing media record with a work memo. The
// association does not own the media record or its underlying file.
type WorkMemoMedia struct {
	ID       string `json:"id"`
	Owner    string `json:"owner"`
	MemoID   string `json:"memo_id"`
	MediaID  string `json:"media_id"`
	Position int    `json:"position"`
	Created  string `json:"created"`
}

// CreateWorkMemoMedia associates media with a memo owned by owner. Ownership
// validation and position allocation happen in the same INSERT statement so a
// caller cannot associate resources belonging to different users.
func (s *Store) CreateWorkMemoMedia(owner, memoID, mediaID string) (*WorkMemoMedia, error) {
	if owner == "" {
		return nil, fmt.Errorf("owner is required")
	}
	if memoID == "" {
		return nil, fmt.Errorf("memo id is required")
	}
	if mediaID == "" {
		return nil, fmt.Errorf("media id is required")
	}

	id, err := GenerateID()
	if err != nil {
		return nil, err
	}
	created := nowString()
	result, err := s.DB.Exec(`
		INSERT INTO work_memo_media(id, owner, memo_id, media_id, position, created)
		SELECT ?, ?, memo.id, media.id,
			COALESCE((
				SELECT MAX(association.position) + 1
				FROM work_memo_media association
				WHERE association.owner = ? AND association.memo_id = memo.id
			), 0),
			?
		FROM work_memos memo
		JOIN media ON media.id = ?
		WHERE memo.id = ? AND memo.owner = ? AND media.owner = ?`,
		id, owner, owner, created, mediaID, memoID, owner, owner,
	)
	if err != nil {
		return nil, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if affected == 0 {
		return nil, sql.ErrNoRows
	}
	return s.getWorkMemoMedia(id, owner)
}

// ListWorkMemoMedia lists the associations for one owner and memo in stable
// display order. Parent joins ensure an inconsistent row cannot cross the
// owner boundary even if the database was modified outside the Store.
func (s *Store) ListWorkMemoMedia(owner, memoID string) ([]*WorkMemoMedia, error) {
	if owner == "" {
		return nil, fmt.Errorf("owner is required")
	}
	if memoID == "" {
		return nil, fmt.Errorf("memo id is required")
	}

	rows, err := s.DB.Query(`
		SELECT association.id, association.owner, association.memo_id,
			association.media_id, association.position, association.created
		FROM work_memo_media association
		JOIN work_memos memo
			ON memo.id = association.memo_id AND memo.owner = association.owner
		JOIN media
			ON media.id = association.media_id AND media.owner = association.owner
		WHERE association.owner = ? AND association.memo_id = ?
		ORDER BY association.position ASC, association.created ASC, association.id ASC`,
		owner, memoID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	items := make([]*WorkMemoMedia, 0)
	for rows.Next() {
		item, err := scanWorkMemoMedia(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// DeleteWorkMemoMediaAssociation removes only an association row. It never
// deletes the media record or any local, S3, or Chevereto file.
func (s *Store) DeleteWorkMemoMediaAssociation(owner, memoID, associationID string) error {
	result, err := s.DB.Exec(
		`DELETE FROM work_memo_media WHERE id = ? AND owner = ? AND memo_id = ?`,
		associationID, owner, memoID,
	)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) getWorkMemoMedia(id, owner string) (*WorkMemoMedia, error) {
	return scanWorkMemoMedia(s.DB.QueryRow(`
		SELECT association.id, association.owner, association.memo_id,
			association.media_id, association.position, association.created
		FROM work_memo_media association
		JOIN work_memos memo
			ON memo.id = association.memo_id AND memo.owner = association.owner
		JOIN media
			ON media.id = association.media_id AND media.owner = association.owner
		WHERE association.id = ? AND association.owner = ?`,
		id, owner,
	))
}

func scanWorkMemoMedia(row interface{ Scan(dest ...any) error }) (*WorkMemoMedia, error) {
	item := &WorkMemoMedia{}
	err := row.Scan(&item.ID, &item.Owner, &item.MemoID, &item.MediaID, &item.Position, &item.Created)
	if err != nil {
		return nil, err
	}
	return item, nil
}
