package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode"

	"golang.org/x/net/html"
)

// Work Memo search sort orders. V1 deliberately supports exactly two orders
// and no relevance ranking: the API contract exposes a sort *name*, so a
// future implementation is free to add ranking without changing callers.
const (
	WorkMemoSortDateDesc = "date_desc"
	WorkMemoSortDateAsc  = "date_asc"
)

// Pagination defaults and bounds for Work Memo search. The HTTP layer rejects
// out-of-range values with a validation error; the Store clamps them as well
// so an internal caller can never build a negative OFFSET or an unbounded page.
const (
	WorkMemoSearchDefaultPage     = 1
	WorkMemoSearchDefaultPageSize = 20
	WorkMemoSearchMaxPageSize     = 50
)

// workMemoSearchTextBackfillKey records in migration_meta that the initial
// search_text backfill has completed, so a normal startup never has to read
// every Work Memo body again. A missing marker (fresh database, newly added
// column, or an interrupted earlier pass) simply re-runs the pass, which is
// idempotent.
const workMemoSearchTextBackfillKey = "work_memo_search_text.backfill"

// WorkMemoSearchQuery describes a read-only Work Memo search. Every field is
// optional, but at least one of Terms, Tag, Status, DateFrom or DateTo must be
// set: the HTTP layer rejects an empty request so this endpoint can never be
// used as a "list everything" API.
//
// DateFrom/DateTo are inclusive YYYY-MM-DD day bounds. Both are compared
// against the stored "YYYY-MM-DD 00:00:00.000Z" value, so they never have to
// parse or reformat the column.
type WorkMemoSearchQuery struct {
	Terms    []string
	Tag      string
	Status   string
	DateFrom string
	DateTo   string
	Sort     string
	Page     int
	PageSize int
}

// WorkMemoSearchResult is one row of a Work Memo search. It intentionally does
// not carry the raw HTML content: the Store never even selects the content
// column on this path, so a search response cannot leak markup. SearchText is
// the backend-derived plain text that the HTTP layer turns into a snippet.
type WorkMemoSearchResult struct {
	ID         string
	Date       string
	Status     string
	IsPinned   bool
	Position   int
	Tags       []string
	SearchText string
}

// SearchWorkMemos returns the Work Memos of a single owner that match every
// supplied criterion, together with the unpaginated total for the same
// criteria.
//
// V1 is a plain SQLite LIKE scan over the derived search_text column. There is
// no FTS5 table, no vector index, no ranking and no external search engine.
// The HTTP contract deliberately hides that choice (filters in, page out), so
// an FTS5 or PostgreSQL full-text implementation can replace this function
// without touching the API layer.
func (s *Store) SearchWorkMemos(owner string, query WorkMemoSearchQuery) ([]*WorkMemoSearchResult, int, error) {
	if owner == "" {
		// Owner isolation is a P0 guarantee: an empty owner would silently
		// widen the query to every user, so it is rejected outright.
		return nil, 0, fmt.Errorf("owner is required")
	}

	orderBy, err := workMemoSearchOrderBy(query.Sort)
	if err != nil {
		return nil, 0, err
	}
	where, args, err := workMemoSearchFilter(owner, query)
	if err != nil {
		return nil, 0, err
	}

	page := query.Page
	if page < 1 {
		page = WorkMemoSearchDefaultPage
	}
	pageSize := query.PageSize
	if pageSize < 1 {
		pageSize = WorkMemoSearchDefaultPageSize
	}
	if pageSize > WorkMemoSearchMaxPageSize {
		pageSize = WorkMemoSearchMaxPageSize
	}

	// The count query reuses the exact same WHERE clause and arguments as the
	// items query, so `total` can never describe a different row set than the
	// page the caller receives.
	var total int
	if err := s.DB.QueryRow(`SELECT COUNT(*) FROM work_memos WHERE `+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	itemArgs := append(make([]any, 0, len(args)+2), args...)
	itemArgs = append(itemArgs, pageSize, (page-1)*pageSize)
	rows, err := s.DB.Query(
		`SELECT id, date, status, is_pinned, position, tags, search_text FROM work_memos WHERE `+where+
			` ORDER BY `+orderBy+` LIMIT ? OFFSET ?`,
		itemArgs...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := make([]*WorkMemoSearchResult, 0, pageSize)
	for rows.Next() {
		var tagsRaw string
		var isPinnedInt int
		item := &WorkMemoSearchResult{}
		if err := rows.Scan(&item.ID, &item.Date, &item.Status, &isPinnedInt, &item.Position, &tagsRaw, &item.SearchText); err != nil {
			return nil, 0, err
		}
		item.IsPinned = isPinnedInt != 0
		item.Tags = decodeStringSlice(tagsRaw)
		items = append(items, item)
	}
	return items, total, rows.Err()
}

// workMemoSearchFilter builds the shared WHERE clause for the items query and
// the count query. Every branch uses a placeholder; no user input is ever
// concatenated into the SQL text.
func workMemoSearchFilter(owner string, query WorkMemoSearchQuery) (string, []any, error) {
	conditions := []string{"owner = ?"}
	args := []any{owner}

	// Multiple whitespace-separated terms are ANDed, so "钢平台 阀门" only
	// matches text containing both. Each term is matched as a literal
	// substring: escapeLikePattern neutralises %, _ and \ so a user cannot
	// smuggle LIKE wildcard syntax into the query.
	for _, term := range query.Terms {
		if term == "" {
			continue
		}
		conditions = append(conditions, `search_text LIKE ? ESCAPE '\'`)
		args = append(args, "%"+escapeLikePattern(term)+"%")
	}

	if query.Tag != "" {
		// Tags are stored as a JSON array (see createMemoTags/encodeJSON), so an
		// exact tag filter is an exact match against one JSON array element.
		// json_valid guards the table function: a row whose tags value is not
		// valid JSON must yield "no match" instead of aborting the whole query.
		// CASE keeps the EXISTS branch from being evaluated in that case.
		conditions = append(conditions, `CASE WHEN json_valid(work_memos.tags) THEN EXISTS (SELECT 1 FROM json_each(work_memos.tags) AS work_memo_tag WHERE work_memo_tag.value = ?) ELSE 0 END`)
		args = append(args, query.Tag)
	}

	if query.Status != "" {
		if !IsValidWorkMemoStatus(query.Status) {
			return "", nil, fmt.Errorf("invalid status: %s", query.Status)
		}
		conditions = append(conditions, "status = ?")
		args = append(args, query.Status)
	}

	if query.DateFrom != "" {
		full, err := normalizeWorkMemoDate(query.DateFrom)
		if err != nil {
			return "", nil, err
		}
		conditions = append(conditions, "date >= ?")
		args = append(args, full)
	}

	if query.DateTo != "" {
		if _, err := normalizeWorkMemoDate(query.DateTo); err != nil {
			return "", nil, err
		}
		// The lower bound produced by normalizeWorkMemoDate is midnight, which
		// would exclude the whole day. For an inclusive upper bound we reuse
		// the same stored layout with the last millisecond of the day.
		conditions = append(conditions, "date <= ?")
		args = append(args, query.DateTo+" 23:59:59.999Z")
	}

	return strings.Join(conditions, " AND "), args, nil
}

// workMemoSearchOrderBy maps a sort name to a fully deterministic ORDER BY
// clause. Both directions share the same tie-breakers, so paging through a
// result set never duplicates or drops a row: pinned first, then the manual
// position, then the id as the final stable key.
//
// Within one date the position is unique, so `id` is a defensive tie-breaker
// rather than a load-bearing one; it is kept because a stable total order is
// what makes offset pagination correct.
func workMemoSearchOrderBy(sort string) (string, error) {
	switch sort {
	case "", WorkMemoSortDateDesc:
		return `date DESC, is_pinned DESC, position ASC, id DESC`, nil
	case WorkMemoSortDateAsc:
		return `date ASC, is_pinned DESC, position ASC, id DESC`, nil
	default:
		return "", fmt.Errorf("invalid sort: %s", sort)
	}
}

// escapeLikePattern makes a user-supplied term a literal LIKE pattern. The
// backslash is the escape character because every LIKE in this file declares
// ESCAPE '\'. Iterating bytes is safe for UTF-8: the three metacharacters are
// ASCII and every continuation byte is >= 0x80, so no multi-byte rune can be
// split or corrupted.
func escapeLikePattern(term string) string {
	if !strings.ContainsAny(term, `\%_`) {
		return term
	}
	var builder strings.Builder
	builder.Grow(len(term) + 4)
	for i := 0; i < len(term); i++ {
		switch term[i] {
		case '\\', '%', '_':
			builder.WriteByte('\\')
		}
		builder.WriteByte(term[i])
	}
	return builder.String()
}

// searchTextSkippedElements are element subtrees whose text is never part of
// the user-visible body text. Skipping them keeps script/style payloads and
// document metadata out of the search index.
var searchTextSkippedElements = map[string]struct{}{
	"script":   {},
	"style":    {},
	"head":     {},
	"title":    {},
	"noscript": {},
	"template": {},
}

// searchTextBlockElements are elements that introduce a visual line break. A
// block boundary contributes a separator so the text of two adjacent blocks
// never merges into one word ("<p>foo</p><p>bar</p>" must search as "foo bar",
// not "foobar").
//
// Inline elements (strong, em, span, a, code, ...) contribute no separator, so
// formatting a part of a word does not split it: "钢<strong>平台</strong>"
// stays searchable as "钢平台", which matters for CJK text that has no spaces
// to fall back on.
var searchTextBlockElements = map[string]struct{}{
	"address":    {},
	"article":    {},
	"aside":      {},
	"blockquote": {},
	"br":         {},
	"caption":    {},
	"dd":         {},
	"details":    {},
	"dialog":     {},
	"div":        {},
	"dl":         {},
	"dt":         {},
	"fieldset":   {},
	"figcaption": {},
	"figure":     {},
	"footer":     {},
	"form":       {},
	"h1":         {},
	"h2":         {},
	"h3":         {},
	"h4":         {},
	"h5":         {},
	"h6":         {},
	"header":     {},
	"hgroup":     {},
	"hr":         {},
	"li":         {},
	"main":       {},
	"menu":       {},
	"nav":        {},
	"ol":         {},
	"p":          {},
	"pre":        {},
	"section":    {},
	"summary":    {},
	"table":      {},
	"tbody":      {},
	"td":         {},
	"tfoot":      {},
	"th":         {},
	"thead":      {},
	"tr":         {},
	"ul":         {},
}

// extractWorkMemoSearchText derives the searchable plain text of a Work Memo
// from its stored HTML content.
//
// This is the single helper the whole backend uses, and it is deliberately a
// real HTML parse rather than a regex strip: only text nodes contribute, so
// tag names, class/style/data-* attributes, image src/blob values and
// data-media-id values can never end up in the index. Character references are
// decoded by the parser ("&amp;" becomes "&", "&nbsp;" becomes a space that the
// normaliser then collapses).
//
// The result is whitespace-normalised and trimmed. An image-only or empty memo
// legitimately derives an empty string.
func extractWorkMemoSearchText(content string) string {
	if content == "" {
		return ""
	}
	doc, err := html.Parse(strings.NewReader(content))
	if err != nil || doc == nil {
		// html.Parse only reports errors from its reader, and a strings.Reader
		// cannot fail, so this branch is unreachable in practice. Degrading to
		// an empty value keeps the row unsearchable by body text instead of
		// storing markup; the next startup backfill pass retries it because the
		// row still has no search_text.
		return ""
	}
	var builder strings.Builder
	builder.Grow(len(content))
	writeSearchTextNodes(&builder, doc)
	return normalizeSearchText(builder.String())
}

func writeSearchTextNodes(builder *strings.Builder, node *html.Node) {
	if node.Type == html.TextNode {
		builder.WriteString(node.Data)
		return
	}
	if node.Type == html.ElementNode {
		name := strings.ToLower(node.Data)
		if _, skip := searchTextSkippedElements[name]; skip {
			return
		}
		if _, block := searchTextBlockElements[name]; block {
			builder.WriteByte(' ')
			writeSearchTextChildren(builder, node)
			builder.WriteByte(' ')
			return
		}
	}
	writeSearchTextChildren(builder, node)
}

func writeSearchTextChildren(builder *strings.Builder, node *html.Node) {
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		writeSearchTextNodes(builder, child)
	}
}

// normalizeSearchText collapses every run of Unicode whitespace (including
// non-breaking spaces produced by &nbsp;) into a single ASCII space and trims
// the result. iterate-by-rune keeps multi-byte characters intact.
func normalizeSearchText(input string) string {
	if input == "" {
		return ""
	}
	var builder strings.Builder
	builder.Grow(len(input))
	pendingSpace := false
	for _, r := range input {
		if unicode.IsSpace(r) {
			// A leading space is dropped rather than written, so trimming is
			// free and no trailing space is ever emitted.
			pendingSpace = builder.Len() > 0
			continue
		}
		if pendingSpace {
			builder.WriteByte(' ')
			pendingSpace = false
		}
		builder.WriteRune(r)
	}
	return builder.String()
}

// ensureWorkMemoSearchText makes the derived search_text column available and
// fills it for rows that predate it.
//
// The project has no versioned migration runner: createSchema issues only
// "CREATE TABLE IF NOT EXISTS" statements and runs on every startup, so adding
// a column to an existing table needs an explicit idempotent step. This
// function follows the same on-every-open convention instead of introducing a
// second migration mechanism, and records its result in migration_meta - the
// existing bookkeeping table - so the data pass itself runs once.
//
// It never touches work_memo_media, the media table or any file: the backfill
// only writes work_memos.search_text.
func ensureWorkMemoSearchText(db *sql.DB) error {
	if err := ensureWorkMemoSearchTextColumn(db); err != nil {
		return err
	}

	done, err := getMeta(db, workMemoSearchTextBackfillKey)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if done != "" {
		return nil
	}
	return backfillWorkMemoSearchText(db)
}

// ensureWorkMemoSearchTextColumn adds work_memos.search_text when an existing
// database does not have it yet. SQLite has no "ADD COLUMN IF NOT EXISTS", so
// the column list is inspected first; running this on every open is then a
// single cheap pragma read.
func ensureWorkMemoSearchTextColumn(db *sql.DB) error {
	hasColumn, err := tableHasColumn(db, "work_memos", "search_text")
	if err != nil {
		return err
	}
	if hasColumn {
		return nil
	}
	// NOT NULL with a constant default is required by SQLite for ADD COLUMN;
	// existing rows receive '' and are filled by the backfill below.
	_, err = db.Exec(`ALTER TABLE work_memos ADD COLUMN search_text TEXT DEFAULT '' NOT NULL`)
	return err
}

func tableHasColumn(db *sql.DB, table, column string) (bool, error) {
	// pragma_table_info is a table-valued function. Its argument cannot be a
	// bound parameter, but both call sites pass package constants, so no user
	// input ever reaches this string.
	rows, err := db.Query(`SELECT name FROM pragma_table_info('` + table + `')`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

// backfillWorkMemoSearchText derives search_text for every Work Memo that does
// not have one yet.
//
// Only rows with an empty search_text are considered, so the pass converges:
// memos whose visible text is genuinely empty (for example an image-only memo)
// stay empty and are simply skipped. `updated` is deliberately left untouched -
// a backfill is not a user edit and must not reorder the timeline.
func backfillWorkMemoSearchText(db *sql.DB) error {
	rows, err := db.Query(`SELECT id, content, search_text FROM work_memos WHERE search_text = ''`)
	if err != nil {
		return err
	}

	type searchTextUpdate struct {
		id   string
		text string
	}
	var updates []searchTextUpdate
	for rows.Next() {
		var id, content, current string
		if err := rows.Scan(&id, &content, &current); err != nil {
			rows.Close()
			return err
		}
		if text := extractWorkMemoSearchText(content); text != current {
			updates = append(updates, searchTextUpdate{id: id, text: text})
		}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	if len(updates) == 0 {
		return setMeta(db, workMemoSearchTextBackfillKey, "done")
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	statement, err := tx.Prepare(`UPDATE work_memos SET search_text = ? WHERE id = ?`)
	if err != nil {
		return err
	}
	defer statement.Close()

	for _, update := range updates {
		if _, err := statement.Exec(update.text, update.id); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	return setMeta(db, workMemoSearchTextBackfillKey, "done")
}
