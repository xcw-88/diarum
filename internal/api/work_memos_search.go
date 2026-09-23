package api

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/labstack/echo/v5"

	"github.com/songtianlun/diarum/internal/auth"
	"github.com/songtianlun/diarum/internal/store"
)

const (
	// workMemoSearchMaxQueryLength bounds the q parameter, counted in runes so
	// a Chinese query is not cut short by a byte limit.
	workMemoSearchMaxQueryLength = 200
	// workMemoSearchMaxTerms bounds how many whitespace-separated AND terms a
	// single q parameter may contain.
	workMemoSearchMaxTerms = 10
	// workMemoSearchSnippetLength is the target snippet length in runes.
	workMemoSearchSnippetLength = 160
)

// registerWorkMemoSearchRoute mounts the read-only search endpoint. It is part
// of the work memos group, so it shares the group's auth middleware and URL
// prefix.
func registerWorkMemoSearchRoute(group *echo.Group, s *store.Store) {
	group.GET("/search", searchWorkMemosHandler(s))
}

// searchWorkMemosHandler answers a paginated Work Memo search.
//
// The endpoint is strictly read-only: it never writes a Work Memo, never
// touches an attachment association and never touches media. It is also not a
// "list everything" API - a request without at least one real criterion is
// rejected, which keeps it from becoming a second timeline endpoint.
func searchWorkMemosHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		// A search response is authenticated, user-private data: it may only
		// ever be served back to the account that asked for it. `private` keeps
		// shared and intermediary caches out, and `no-store` forbids every
		// cache layer - the browser HTTP cache, the disk cache and a service
		// worker's Cache Storage - from keeping a copy. This matters because a
		// cache entry is keyed by URL, not by credentials: without `no-store`,
		// a second account signing in on the same browser could be handed the
		// previous account's hits (via the PWA `api-cache`, or offline) for the
		// very same `/search?q=...` URL.
		//
		// The header is set before any parsing or writing, so the validation
		// and server errors of this handler carry the same "never cache"
		// contract instead of falling back to a cacheable 400/500.
		c.Response().Header().Set(echo.HeaderCacheControl, "private, no-store")
		// A complement, not a substitute: a cache that ignored `private` still
		// cannot reuse this response for a request carrying another token.
		c.Response().Header().Set(echo.HeaderVary, echo.HeaderAuthorization)

		// The owner comes exclusively from the authenticated request context.
		// There is no owner query parameter and no owner field anywhere in the
		// request, so a caller cannot widen the search to another user.
		user := auth.CurrentUser(c)

		query, err := parseWorkMemoSearchQuery(c)
		if err != nil {
			return badRequest(err.Error(), nil)
		}

		items, total, err := s.SearchWorkMemos(user.ID, query)
		if err != nil {
			return serverError("Failed to search work memos", err)
		}

		results := make([]map[string]any, 0, len(items))
		for _, item := range items {
			results = append(results, map[string]any{
				"id":   item.ID,
				"date": store.FormatWorkMemoDateAPI(item.Date),
				// The snippet is plain text derived from the searchable text,
				// never from the stored HTML. The item deliberately carries no
				// content field: a search response must not return full markup.
				"snippet":   buildWorkMemoSnippet(item.SearchText, query.Terms, workMemoSearchSnippetLength),
				"status":    item.Status,
				"is_pinned": item.IsPinned,
				"tags":      item.Tags,
				"position":  item.Position,
			})
		}

		return c.JSON(http.StatusOK, map[string]any{
			"items":       results,
			"page":        query.Page,
			"page_size":   query.PageSize,
			"total":       total,
			"total_pages": store.TotalPages(total, query.PageSize),
		})
	}
}

// parseWorkMemoSearchQuery validates the query string into a Store query.
//
// Defaults apply only when a parameter is absent. A parameter that is present
// but malformed or out of range is rejected with a validation error rather than
// silently clamped, so a client can never believe it searched page 3 while the
// server served page 1.
func parseWorkMemoSearchQuery(c echo.Context) (store.WorkMemoSearchQuery, error) {
	query := store.WorkMemoSearchQuery{
		Sort:     store.WorkMemoSortDateDesc,
		Page:     store.WorkMemoSearchDefaultPage,
		PageSize: store.WorkMemoSearchDefaultPageSize,
	}

	rawQuery := strings.TrimSpace(c.QueryParam("q"))
	if rawQuery != "" {
		if utf8.RuneCountInString(rawQuery) > workMemoSearchMaxQueryLength {
			return query, fmt.Errorf("q must be at most %d characters", workMemoSearchMaxQueryLength)
		}
		// strings.Fields splits on Unicode whitespace, so a full-width space
		// separates terms the same way an ASCII space does.
		terms := strings.Fields(rawQuery)
		if len(terms) > workMemoSearchMaxTerms {
			return query, fmt.Errorf("q must contain at most %d terms", workMemoSearchMaxTerms)
		}
		query.Terms = terms
	}

	query.Tag = strings.TrimSpace(c.QueryParam("tag"))

	if rawStatus := strings.TrimSpace(c.QueryParam("status")); rawStatus != "" {
		if !store.IsValidWorkMemoStatus(rawStatus) {
			return query, errors.New("invalid status")
		}
		query.Status = rawStatus
	}

	query.DateFrom = strings.TrimSpace(c.QueryParam("date_from"))
	if query.DateFrom != "" {
		if _, err := parseWorkMemoDate(query.DateFrom); err != nil {
			return query, errors.New("invalid date_from")
		}
	}
	query.DateTo = strings.TrimSpace(c.QueryParam("date_to"))
	if query.DateTo != "" {
		if _, err := parseWorkMemoDate(query.DateTo); err != nil {
			return query, errors.New("invalid date_to")
		}
	}
	// Both bounds are YYYY-MM-DD, so lexicographic comparison is chronological.
	if query.DateFrom != "" && query.DateTo != "" && query.DateFrom > query.DateTo {
		return query, errors.New("date_from must not be after date_to")
	}

	if len(query.Terms) == 0 && query.Tag == "" && query.Status == "" && query.DateFrom == "" && query.DateTo == "" {
		return query, errors.New("at least one of q, tag, status, date_from or date_to is required")
	}

	if rawPage := strings.TrimSpace(c.QueryParam("page")); rawPage != "" {
		page, err := strconv.Atoi(rawPage)
		if err != nil || page < 1 {
			return query, errors.New("page must be an integer greater than or equal to 1")
		}
		query.Page = page
	}
	if rawPageSize := strings.TrimSpace(c.QueryParam("page_size")); rawPageSize != "" {
		pageSize, err := strconv.Atoi(rawPageSize)
		if err != nil || pageSize < 1 || pageSize > store.WorkMemoSearchMaxPageSize {
			return query, fmt.Errorf("page_size must be an integer between 1 and %d", store.WorkMemoSearchMaxPageSize)
		}
		query.PageSize = pageSize
	}

	if rawSort := strings.TrimSpace(c.QueryParam("sort")); rawSort != "" {
		switch rawSort {
		case store.WorkMemoSortDateDesc, store.WorkMemoSortDateAsc:
			query.Sort = rawSort
		default:
			return query, errors.New("sort must be date_desc or date_asc")
		}
	}

	return query, nil
}

// buildWorkMemoSnippet renders the plain-text preview of one search result.
//
// The preview is built from the backend-derived searchable text, never from the
// stored HTML, and it is returned as plain text: the response contains no
// markup, no <mark> element and nothing the frontend would have to feed to
// {@html}.
func buildWorkMemoSnippet(text string, terms []string, limit int) string {
	if text == "" || limit <= 0 {
		return ""
	}
	runes := []rune(text)
	if len(runes) <= limit {
		return text
	}

	start := 0
	if match := firstSearchTermMatch(runes, terms); match >= 0 {
		// Prefer context around the first match, biased towards the text that
		// precedes it so the reader can recognise the sentence. The window is
		// clamped back inside the text when the match sits near either end.
		start = match - limit/3
		if start < 0 {
			start = 0
		}
		if start+limit > len(runes) {
			start = len(runes) - limit
		}
	}

	end := start + limit
	snippet := string(runes[start:end])
	if start > 0 {
		snippet = "..." + snippet
	}
	if end < len(runes) {
		snippet = snippet + "..."
	}
	return snippet
}

// firstSearchTermMatch returns the rune index of the earliest occurrence of any
// search term, or -1 when none of them appears in the text.
func firstSearchTermMatch(text []rune, terms []string) int {
	best := -1
	for _, term := range terms {
		if term == "" {
			continue
		}
		index := indexFoldRunes(text, []rune(term))
		if index < 0 {
			continue
		}
		if best < 0 || index < best {
			best = index
		}
	}
	return best
}

func indexFoldRunes(text, pattern []rune) int {
	if len(pattern) == 0 || len(pattern) > len(text) {
		return -1
	}
	for i := 0; i+len(pattern) <= len(text); i++ {
		matched := true
		for j, want := range pattern {
			if !equalSearchRune(text[i+j], want) {
				matched = false
				break
			}
		}
		if matched {
			return i
		}
	}
	return -1
}

// equalSearchRune compares two runes the way the search itself does: case
// insensitively for ASCII (matching SQLite's default LIKE behaviour) and by
// exact code point for everything else.
func equalSearchRune(a, b rune) bool {
	if a == b {
		return true
	}
	if a >= utf8.RuneSelf || b >= utf8.RuneSelf {
		return false
	}
	return unicode.ToLower(a) == unicode.ToLower(b)
}
