-- One-off removal of the retired discussion-room model (rooms with speaking turns, a room-scoped runtime, relay and
-- phase) from an existing D1 or SQLite database. Python startup runs this in one transaction before schema.sql.
-- For D1, back up first and obtain the user's confirmation before running the destructive migration, e.g.
--   npx wrangler d1 export DB --remote --output backup.sql
--   npx wrangler d1 execute DB --remote --file backend/migrations/drop_legacy_discussion.sql
--   npx wrangler d1 execute DB --remote --file backend/schema.sql
-- Local callers must wrap the whole script in a transaction, as Python startup does. Safe to repeat after success.
-- Rooms of the old model stay readable as collaboration rooms; without an owner credential, the owner cannot manage
-- the room. Existing member credentials keep their permissions.
PRAGMA defer_foreign_keys = ON;

-- This script runs before schema.sql, so a database older than these tables gets them here; same definitions as schema.sql.
CREATE TABLE IF NOT EXISTS room_modes (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode='free'),
    control_hash TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS room_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    adapter TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','host')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','away','removed')),
    token_hash TEXT NOT NULL,
    read_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    access TEXT NOT NULL DEFAULT 'runner',
    session_mode TEXT NOT NULL DEFAULT 'new'
);
CREATE TABLE IF NOT EXISTS member_manual_sources (
    member_id INTEGER PRIMARY KEY REFERENCES room_members(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK(source='web')
);
CREATE TABLE IF NOT EXISTS discussion_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paused' CHECK(status IN ('active','paused','concluded')),
    started_message_id INTEGER NOT NULL DEFAULT 0,
    ended_message_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session_state (
    session_id INTEGER PRIMARY KEY REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK(phase IN ('initial','discussing')),
    revision INTEGER NOT NULL DEFAULT 0,
    read_until INTEGER NOT NULL DEFAULT 0,
    held_since INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    file_name TEXT NOT NULL, content_type TEXT NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    actor TEXT NOT NULL, submission_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(room_id, submission_id)
);
CREATE TABLE IF NOT EXISTS execution_segments (
    source TEXT NOT NULL CHECK(source='free'),
    execution_id INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    phase TEXT NOT NULL,
    tool TEXT NOT NULL DEFAULT '',
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    PRIMARY KEY(source,execution_id,seq)
);

-- Every room is a collaboration room; members given as online are manual members relayed from the web.
UPDATE room_modes SET mode='free' WHERE mode<>'free';
INSERT OR IGNORE INTO room_modes (room_id,mode,control_hash) SELECT id,'free','' FROM rooms;
INSERT OR IGNORE INTO member_manual_sources (member_id,source) SELECT id,'web' FROM room_members WHERE access='online';
UPDATE room_members SET access='manual' WHERE access='online';

-- Triggers of the old model; dropped before any table, because renaming a table below checks every trigger.
DROP TRIGGER IF EXISTS reject_archived_resume;
DROP TRIGGER IF EXISTS validate_turn_answer;
DROP TRIGGER IF EXISTS reject_inactive_opinion;
DROP TRIGGER IF EXISTS reject_inactive_turn;
DROP TRIGGER IF EXISTS reject_conclusion_with_open_turn;
DROP TRIGGER IF EXISTS require_opinion_turn;
DROP TRIGGER IF EXISTS initialize_room_floor;
DROP TRIGGER IF EXISTS transfer_host_floor;
DROP TRIGGER IF EXISTS require_message_floor;
DROP TRIGGER IF EXISTS return_message_floor;
DROP TRIGGER IF EXISTS require_host_floor;
DROP TRIGGER IF EXISTS nominate_expert_floor;
DROP TRIGGER IF EXISTS cancel_turn_floor;
DROP TRIGGER IF EXISTS limits_topic_started;
DROP TRIGGER IF EXISTS limits_phase_started;
DROP TRIGGER IF EXISTS limits_turn_started;
DROP TRIGGER IF EXISTS record_event_timing;
DROP TRIGGER IF EXISTS runtime_generation;
DROP TRIGGER IF EXISTS runtime_turn_created;
DROP TRIGGER IF EXISTS relay_turn_promoted;
DROP TRIGGER IF EXISTS relay_plan_replaced;
DROP TRIGGER IF EXISTS relay_hold_user_message;
DROP TRIGGER IF EXISTS relay_hold_goal;
DROP TRIGGER IF EXISTS relay_hold_topic;
DROP TRIGGER IF EXISTS relay_plan_concluded;
DROP TRIGGER IF EXISTS relay_plan_participants;
DROP TRIGGER IF EXISTS runtime_turn_answered;
DROP TRIGGER IF EXISTS runtime_topic_stop;
DROP TRIGGER IF EXISTS runtime_user_message;
DROP TRIGGER IF EXISTS runtime_turn_cancelled;
DROP TRIGGER IF EXISTS runtime_archive;
DROP TRIGGER IF EXISTS runtime_participants_changed;
DROP TRIGGER IF EXISTS runtime_experts_changed;
DROP TRIGGER IF EXISTS runtime_goal_changed;
DROP TRIGGER IF EXISTS runtime_constraints_changed;
DROP TRIGGER IF EXISTS pause_clock_stopped;
DROP TRIGGER IF EXISTS pause_clock_resumed;
DROP TRIGGER IF EXISTS session_for_new_discussion;
DROP TRIGGER IF EXISTS session_follows_phase_insert;
DROP TRIGGER IF EXISTS session_follows_phase;
DROP TRIGGER IF EXISTS conclusion_snapshot;
DROP TRIGGER IF EXISTS revision_free_settings_insert;
DROP TRIGGER IF EXISTS revision_free_settings_update;
-- Reads message_details; re-created below once the table is rebuilt.
DROP TRIGGER IF EXISTS validate_attachment_link;

-- Retired sessions have no request-model state and must not block the room's next discussion.
UPDATE discussion_sessions SET status='concluded',
    ended_message_id=COALESCE((SELECT MAX(id) FROM messages WHERE room_id=discussion_sessions.room_id),0)
WHERE status IN ('active','paused') AND NOT EXISTS (SELECT 1 FROM session_state WHERE session_id=discussion_sessions.id);

-- message_details without turn_id, whose foreign key names discussion_turns.
CREATE TABLE IF NOT EXISTS message_details_rebuilt (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id),
    kind TEXT NOT NULL DEFAULT 'opinion', submitted_by TEXT NOT NULL
);
INSERT OR IGNORE INTO message_details_rebuilt (message_id,kind,submitted_by)
    SELECT message_id,kind,submitted_by FROM message_details;
DROP TABLE message_details;
ALTER TABLE message_details_rebuilt RENAME TO message_details;
CREATE TRIGGER IF NOT EXISTS validate_attachment_link BEFORE UPDATE OF message_id ON attachments
WHEN NEW.message_id IS NOT NULL AND (
    (OLD.message_id IS NOT NULL AND OLD.message_id != NEW.message_id)
    OR NOT EXISTS (
        SELECT 1 FROM messages m JOIN message_details d ON d.message_id=m.id
        WHERE m.id=NEW.message_id AND m.room_id=NEW.room_id AND d.submitted_by=NEW.actor
    )
)
BEGIN
    SELECT RAISE(ABORT, 'attachment_unavailable');
END;

-- Phase segments of the old runtime's events.
DELETE FROM execution_segments WHERE source<>'free';

-- Tables only the old model read or wrote. topic_settings keeps its unused phase column and discussion_limits its unused
-- clock columns; both tables are still current.
DROP TABLE IF EXISTS event_timings;
DROP TABLE IF EXISTS discussion_events;
DROP TABLE IF EXISTS discussion_runtime;
DROP TABLE IF EXISTS turn_relay;
DROP TABLE IF EXISTS discussion_pauses;
DROP TABLE IF EXISTS discussion_options;
DROP TABLE IF EXISTS round_budgets;
DROP TABLE IF EXISTS free_settings;
DROP TABLE IF EXISTS room_links;
DROP TABLE IF EXISTS room_floor;
DROP TABLE IF EXISTS discussion_turns;
DROP TABLE IF EXISTS schema_migrations;
