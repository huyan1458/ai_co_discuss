CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
    state_text TEXT NOT NULL DEFAULT '', state_until INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_directory (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    position INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1))
);
INSERT OR IGNORE INTO room_directory (room_id,position)
    SELECT id,ROW_NUMBER() OVER (ORDER BY created_at,id) FROM rooms;
CREATE TRIGGER IF NOT EXISTS add_room_to_directory AFTER INSERT ON rooms
BEGIN
    INSERT INTO room_directory (room_id,position)
        VALUES (NEW.id,(SELECT COALESCE(MAX(position),0)+1 FROM room_directory));
END;
CREATE TABLE IF NOT EXISTS topic_folders (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS room_folder_assignments (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    folder_id TEXT REFERENCES topic_folders(id) ON DELETE SET NULL
);
INSERT OR IGNORE INTO room_folder_assignments (room_id,folder_id)
    SELECT id,NULL FROM rooms;
CREATE TRIGGER IF NOT EXISTS add_room_to_folder_assignments AFTER INSERT ON rooms
BEGIN
    INSERT INTO room_folder_assignments (room_id,folder_id) VALUES (NEW.id,NULL);
END;
CREATE TABLE IF NOT EXISTS room_creations (
    submission_id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL UNIQUE REFERENCES rooms(id),
    request_text TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS room_briefs (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    text TEXT NOT NULL, until INTEGER NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL REFERENCES rooms(id),
    author TEXT NOT NULL, text TEXT NOT NULL, reply_to INTEGER REFERENCES messages(id),
    source TEXT NOT NULL, submission_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(room_id, submission_id)
);
CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, id);
CREATE TABLE IF NOT EXISTS message_summaries (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id),
    text TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS topic_settings (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    host TEXT NOT NULL, background TEXT NOT NULL DEFAULT '', boundaries TEXT NOT NULL DEFAULT '',
    experts TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'preparing', focus TEXT NOT NULL DEFAULT ''
);
CREATE TRIGGER IF NOT EXISTS reject_archived_resume BEFORE UPDATE OF phase ON topic_settings
WHEN NEW.phase NOT IN ('paused','concluded')
    AND EXISTS (SELECT 1 FROM room_directory WHERE room_id=NEW.room_id AND archived=1)
BEGIN
    SELECT RAISE(ABORT, 'topic_archived');
END;
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

CREATE TABLE IF NOT EXISTS room_floor (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    holder TEXT,
    next_speaker TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO room_floor (room_id,holder,next_speaker)
    SELECT rooms.id,CASE WHEN turns.id IS NULL THEN COALESCE(settings.host,'用户') END,
        COALESCE(turns.expert,settings.host,'用户')
    FROM rooms LEFT JOIN topic_settings AS settings ON settings.room_id=rooms.id
    LEFT JOIN discussion_turns AS turns ON turns.room_id=rooms.id AND turns.status IN ('pending','notified');
CREATE TRIGGER IF NOT EXISTS initialize_room_floor AFTER INSERT ON topic_settings
BEGIN
    INSERT INTO room_floor (room_id,holder,next_speaker) VALUES (NEW.room_id,NEW.host,NEW.host)
        ON CONFLICT(room_id) DO UPDATE SET
        holder=CASE WHEN holder='用户' THEN NEW.host ELSE holder END,
        next_speaker=CASE WHEN next_speaker='用户' THEN NEW.host ELSE next_speaker END,
        revision=revision+1;
END;
CREATE TRIGGER IF NOT EXISTS transfer_host_floor AFTER UPDATE OF host ON topic_settings
WHEN OLD.host<>NEW.host
BEGIN
    UPDATE room_floor SET holder=CASE WHEN holder=OLD.host THEN NEW.host ELSE holder END,
        next_speaker=CASE WHEN next_speaker=OLD.host THEN NEW.host ELSE next_speaker END,
        revision=revision+1 WHERE room_id=NEW.room_id
        AND NOT EXISTS (SELECT 1 FROM discussion_turns WHERE room_id=NEW.room_id AND status IN ('pending','notified') AND expert=OLD.host);
END;
CREATE TRIGGER IF NOT EXISTS require_message_floor BEFORE INSERT ON messages
WHEN NEW.author<>'用户'
    AND NOT EXISTS (SELECT 1 FROM messages WHERE room_id=NEW.room_id AND submission_id=NEW.submission_id)
    AND NOT EXISTS (SELECT 1 FROM room_floor WHERE room_id=NEW.room_id AND holder=NEW.author)
BEGIN
    SELECT RAISE(ABORT, 'floor_required');
END;
CREATE TRIGGER IF NOT EXISTS require_opinion_turn BEFORE INSERT ON message_details
WHEN NEW.kind='opinion' AND NEW.turn_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM message_details WHERE message_id=NEW.message_id)
    AND EXISTS (SELECT 1 FROM messages WHERE id=NEW.message_id AND author<>'用户')
BEGIN
    SELECT RAISE(ABORT, 'floor_turn_required');
END;
CREATE TRIGGER IF NOT EXISTS return_message_floor AFTER INSERT ON message_details
WHEN EXISTS (SELECT 1 FROM messages WHERE id=NEW.message_id AND author<>'用户')
BEGIN
    UPDATE room_floor SET holder=NULL,
        next_speaker=COALESCE((SELECT host FROM topic_settings WHERE room_id=room_floor.room_id),'用户'),
        revision=revision+1 WHERE room_id=(SELECT room_id FROM messages WHERE id=NEW.message_id);
END;
CREATE TRIGGER IF NOT EXISTS require_host_floor BEFORE INSERT ON discussion_turns
WHEN NOT EXISTS (SELECT 1 FROM discussion_turns WHERE room_id=NEW.room_id AND submission_id=NEW.submission_id)
    AND NOT EXISTS (SELECT 1 FROM room_floor WHERE room_id=NEW.room_id
                    AND holder=COALESCE((SELECT host FROM topic_settings WHERE room_id=NEW.room_id),'用户'))
BEGIN
    SELECT RAISE(ABORT, 'floor_required');
END;
CREATE TRIGGER IF NOT EXISTS nominate_expert_floor AFTER INSERT ON discussion_turns
BEGIN
    UPDATE room_floor SET holder=NULL,next_speaker=NEW.expert,revision=revision+1 WHERE room_id=NEW.room_id;
END;
CREATE TRIGGER IF NOT EXISTS cancel_turn_floor AFTER UPDATE OF status ON discussion_turns
WHEN NEW.status='cancelled' AND OLD.status<>NEW.status
BEGIN
    UPDATE room_floor SET holder=NULL,
        next_speaker=COALESCE((SELECT host FROM topic_settings WHERE room_id=NEW.room_id),'用户'),
        revision=revision+1 WHERE room_id=NEW.room_id;
END;
