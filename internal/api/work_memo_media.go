package api

import (
	"errors"
	"net/http"

	"github.com/labstack/echo/v5"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"

	"github.com/songtianlun/diarum/internal/auth"
	"github.com/songtianlun/diarum/internal/store"
)

// RegisterWorkMemoMediaRoutes registers the attachment association endpoints
// for work memos. It is called from RegisterWorkMemoRoutes so the routes share
// the same auth middleware and URL prefix as the rest of the work memo API.
//
//	POST   /api/v1/work-memos/:id/media
//	GET    /api/v1/work-memos/:id/media
//	DELETE /api/v1/work-memos/:id/media/:associationId
//
// These endpoints only manage the WorkMemo <-> Media association. They never
// upload files, never create media, and never delete the underlying media
// record or file; file upload continues to use POST /api/v1/media.
func RegisterWorkMemoMediaRoutes(group *echo.Group, s *store.Store) {
	group.POST("/:id/media", createWorkMemoMediaHandler(s))
	group.GET("/:id/media", listWorkMemoMediaHandler(s))
	group.DELETE("/:id/media/:associationId", deleteWorkMemoMediaHandler(s))
}

// createWorkMemoMediaBody is the request payload for associating an existing
// media record with a work memo. The owner, memo id, position and timestamps
// are all derived from the authenticated user, the URL, and the Store. A client
// must not be able to submit them.
type createWorkMemoMediaBody struct {
	MediaID string `json:"media_id"`
}

func createWorkMemoMediaHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := auth.CurrentUser(c)
		var body createWorkMemoMediaBody
		if err := c.Bind(&body); err != nil {
			return badRequest("Invalid request body", err)
		}
		if body.MediaID == "" {
			return badRequest("media_id is required", nil)
		}
		memoID := c.PathParam("id")

		association, err := s.CreateWorkMemoMedia(user.ID, memoID, body.MediaID)
		if err != nil {
			// The Store uses an INSERT ... SELECT that joins work_memos and
			// media on owner, so a missing, non-existent, or cross-owner memo
			// or media all collapse to "no rows affected" -> sql.ErrNoRows.
			// We intentionally do not distinguish these cases at the HTTP
			// layer to avoid leaking which resource exists or belongs to
			// another user.
			if store.IsNoRows(err) {
				return notFound("Work memo or media not found")
			}
			var sqliteErr *sqlite.Error
			if errors.As(err, &sqliteErr) && isUniqueConstraint(sqliteErr) {
				return conflict("This media is already attached to the work memo")
			}
			return serverError("Failed to attach media to work memo", err)
		}
		return c.JSON(http.StatusCreated, formatWorkMemoMediaResponse(association))
	}
}

func listWorkMemoMediaHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := auth.CurrentUser(c)
		memoID := c.PathParam("id")

		items, err := s.ListWorkMemoMedia(user.ID, memoID)
		if err != nil {
			return serverError("Failed to list work memo media", err)
		}
		// ListWorkMemoMedia already enforces owner isolation via the parent
		// joins: an empty result for a memo the user does not own is the same
		// sql.ErrNoRows path as a missing memo. To keep the 404 semantics
		// consistent with the single-work-memo endpoint, we verify the memo
		// exists and belongs to the caller before listing.
		if len(items) == 0 {
			if _, getErr := s.GetWorkMemo(memoID, user.ID); getErr != nil {
				// A missing memo (including one owned by another user) is
				// reported as sql.ErrNoRows by the Store and must map to 404.
				// Any other Store/DB error is an unexpected server fault and
				// must NOT be disguised as 404.
				if store.IsNoRows(getErr) {
					return notFound("Work memo not found")
				}
				return serverError("Failed to verify work memo", getErr)
			}
		}
		return c.JSON(http.StatusOK, map[string]any{"media": formatWorkMemoMediaList(items)})
	}
}

func deleteWorkMemoMediaHandler(s *store.Store) echo.HandlerFunc {
	return func(c echo.Context) error {
		user := auth.CurrentUser(c)
		memoID := c.PathParam("id")
		associationID := c.PathParam("associationId")

		err := s.DeleteWorkMemoMediaAssociation(user.ID, memoID, associationID)
		if err != nil {
			if store.IsNoRows(err) {
				return notFound("Work memo media association not found")
			}
			return serverError("Failed to delete work memo media association", err)
		}
		// NOTE: this only removes the association row. It never calls
		// DeleteMedia or DeleteMediaFile, so the media record, the local
		// file, any S3 object, and every other memo's association to the
		// same media are left untouched.
		return c.JSON(http.StatusOK, map[string]any{"success": true})
	}
}

// formatWorkMemoMediaResponse renders a single association. The owner is never
// returned to the client; association ownership is fixed by the authenticated
// user in the Store layer.
func formatWorkMemoMediaResponse(association *store.WorkMemoMedia) map[string]any {
	return map[string]any{
		"id":       association.ID,
		"memo_id":  association.MemoID,
		"media_id": association.MediaID,
		"position": association.Position,
		"created":  association.Created,
	}
}

func formatWorkMemoMediaList(items []*store.WorkMemoMedia) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		out = append(out, formatWorkMemoMediaResponse(item))
	}
	return out
}

// isUniqueConstraint reports whether a SQLite error is specifically a UNIQUE
// constraint violation on the work_memo_media association. The driver enables
// extended result codes, so a duplicate association surfaces as
// SQLITE_CONSTRAINT_UNIQUE (2067). We accept ONLY that precise code: a generic
// SQLITE_CONSTRAINT (19) merely means "some constraint failed" and does NOT
// prove the failure came from UNIQUE(memo_id, media_id), so accepting it would
// wrongly map unrelated constraint errors to HTTP 409. Detection relies on the
// driver's typed error and extended result code rather than fragile string
// matching.
func isUniqueConstraint(err *sqlite.Error) bool {
	return err.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE
}

func conflict(message string) error {
	return echo.NewHTTPError(http.StatusConflict, message)
}
