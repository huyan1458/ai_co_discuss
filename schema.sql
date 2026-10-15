CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
    state_text TEXT NOT NULL DEFAULT '', state_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id),
    author TEXT NOT NULL, text TEXT NOT NULL, reply_to INTEGER REFERENCES messages(id),
    source TEXT NOT NULL, submission_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(room_id, submission_id)
);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, id);

CREATE TABLE IF NOT EXISTS topic_settings (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    host TEXT NOT NULL, background TEXT NOT NULL DEFAULT '', boundaries TEXT NOT NULL DEFAULT '',
    experts TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'preparing', focus TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS discussion_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id),
    expert TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    submission_id TEXT NOT NULL, created_at TEXT NOT NULL, notified_at TEXT NOT NULL DEFAULT '',
    answer_id INTEGER REFERENCES messages(id), UNIQUE(room_id, submission_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_turn ON discussion_turns(room_id)
    WHERE status IN ('pending', 'notified');
CREATE TABLE IF NOT EXISTS message_details (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id),
    kind TEXT NOT NULL DEFAULT 'opinion', submitted_by TEXT NOT NULL,
    turn_id INTEGER UNIQUE REFERENCES discussion_turns(id)
);
CREATE TRIGGER IF NOT EXISTS validate_turn_answer BEFORE INSERT ON message_details
WHEN NEW.turn_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM message_details WHERE message_id=NEW.message_id)
    AND NOT EXISTS (
        SELECT 1 FROM discussion_turns JOIN messages ON messages.id=NEW.message_id
        WHERE discussion_turns.id=NEW.turn_id AND discussion_turns.room_id=messages.room_id
        AND discussion_turns.expert=messages.author AND discussion_turns.status IN ('pending','notified')
        AND NEW.kind='opinion'
    )
BEGIN
    SELECT RAISE(ABORT, 'turn_unavailable');
END;

CREATE TRIGGER IF NOT EXISTS reject_inactive_opinion BEFORE INSERT ON message_details
WHEN NEW.kind='opinion'
    AND NOT EXISTS (SELECT 1 FROM message_details WHERE message_id=NEW.message_id)
    AND EXISTS (SELECT 1 FROM messages JOIN topic_settings ON topic_settings.room_id=messages.room_id
                WHERE messages.id=NEW.message_id AND topic_settings.phase IN ('paused','concluded'))
BEGIN
    SELECT RAISE(ABORT, 'topic_inactive');
END;
CREATE TRIGGER IF NOT EXISTS reject_inactive_turn BEFORE INSERT ON discussion_turns
WHEN NOT EXISTS (SELECT 1 FROM discussion_turns WHERE room_id=NEW.room_id AND submission_id=NEW.submission_id)
    AND EXISTS (SELECT 1 FROM topic_settings WHERE room_id=NEW.room_id AND phase IN ('paused','concluded'))
BEGIN
    SELECT RAISE(ABORT, 'topic_inactive');
END;
CREATE TRIGGER IF NOT EXISTS reject_conclusion_with_open_turn BEFORE UPDATE OF phase ON topic_settings
WHEN NEW.phase='concluded'
    AND EXISTS (SELECT 1 FROM discussion_turns WHERE room_id=NEW.room_id AND status IN ('pending','notified'))
BEGIN
    SELECT RAISE(ABORT, 'open_turn');
END;
