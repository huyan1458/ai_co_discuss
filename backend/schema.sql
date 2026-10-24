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
CREATE TABLE IF NOT EXISTS directory_settings (
    id INTEGER PRIMARY KEY CHECK (id=1),
    uncategorized_position INTEGER CHECK (uncategorized_position>=0)
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
CREATE TABLE IF NOT EXISTS room_user_requests (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id),
    text TEXT NOT NULL DEFAULT ''
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
CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    file_name TEXT NOT NULL, content_type TEXT NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL,
    actor TEXT NOT NULL, submission_id TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(room_id, submission_id)
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id, position);
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
-- Site administrator account (single user) and its login sessions. Raw tokens and passwords are never stored.
CREATE TABLE IF NOT EXISTS site_admin (
    id INTEGER PRIMARY KEY CHECK(id=1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
);

-- Free collaboration rooms. Rooms without a row are brainstorm rooms and keep every rule below.
CREATE TABLE IF NOT EXISTS room_modes (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('free','brainstorm')),
    control_hash TEXT NOT NULL DEFAULT ''
);
-- Replaced on every start so existing databases drop the floor rule for free rooms.
DROP TRIGGER IF EXISTS require_message_floor;
CREATE TRIGGER require_message_floor BEFORE INSERT ON messages
WHEN NEW.author<>'用户'
    AND NOT EXISTS (SELECT 1 FROM messages WHERE room_id=NEW.room_id AND submission_id=NEW.submission_id)
    AND NOT EXISTS (SELECT 1 FROM room_floor WHERE room_id=NEW.room_id AND holder=NEW.author)
    AND NOT EXISTS (SELECT 1 FROM room_modes WHERE room_id=NEW.room_id AND mode='free')
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
DROP TRIGGER IF EXISTS require_host_floor;
-- Queued turns of a round plan are inserted after the first one has already nominated an expert.
CREATE TRIGGER require_host_floor BEFORE INSERT ON discussion_turns
WHEN NEW.status<>'queued' AND NOT EXISTS (SELECT 1 FROM discussion_turns WHERE room_id=NEW.room_id AND submission_id=NEW.submission_id)
    AND NOT EXISTS (SELECT 1 FROM room_floor WHERE room_id=NEW.room_id
                    AND holder=COALESCE((SELECT host FROM topic_settings WHERE room_id=NEW.room_id),'用户'))
BEGIN
    SELECT RAISE(ABORT, 'floor_required');
END;
DROP TRIGGER IF EXISTS nominate_expert_floor;
CREATE TRIGGER nominate_expert_floor AFTER INSERT ON discussion_turns
WHEN NEW.status<>'queued'
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

-- Runtime control is opt-in. Legacy rooms have no runtime row and keep manual entry.
CREATE TABLE IF NOT EXISTS discussion_limits (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    max_rounds INTEGER NOT NULL DEFAULT 0,
    max_minutes INTEGER NOT NULL DEFAULT 0,
    execution_minutes INTEGER NOT NULL DEFAULT 0,
    on_limit TEXT NOT NULL DEFAULT 'pause',
    summary_minutes INTEGER NOT NULL DEFAULT 5,
    started_at INTEGER NOT NULL DEFAULT 0,
    closing_at INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO discussion_limits(room_id,execution_minutes) SELECT id,0 FROM rooms;
DROP TRIGGER IF EXISTS limits_room_created;
CREATE TRIGGER limits_room_created AFTER INSERT ON rooms
BEGIN
    INSERT INTO discussion_limits(room_id,execution_minutes) VALUES (NEW.id,0);
END;
CREATE TRIGGER IF NOT EXISTS limits_topic_started AFTER INSERT ON topic_settings
WHEN NEW.phase IN ('initial','discussing','reviewing')
BEGIN
    UPDATE discussion_limits SET started_at=CAST(strftime('%s','now') AS INTEGER) WHERE room_id=NEW.room_id AND started_at=0;
END;
CREATE TRIGGER IF NOT EXISTS limits_phase_started AFTER UPDATE OF phase ON topic_settings
WHEN NEW.phase IN ('initial','discussing','reviewing') AND NEW.phase<>OLD.phase
BEGIN
    UPDATE discussion_limits SET started_at=CAST(strftime('%s','now') AS INTEGER) WHERE room_id=NEW.room_id AND started_at=0;
END;
CREATE TRIGGER IF NOT EXISTS limits_turn_started AFTER INSERT ON discussion_turns
BEGIN
    UPDATE discussion_limits SET started_at=CAST(strftime('%s','now') AS INTEGER) WHERE room_id=NEW.room_id AND started_at=0;
END;
CREATE TABLE IF NOT EXISTS discussion_runtime (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('manual','automatic')),
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('ready','running','paused','stopped','concluded')),
    control_hash TEXT NOT NULL,
    deadline INTEGER NOT NULL DEFAULT 0, -- 0 means no run duration limit; execution leases remain bounded.
    revision INTEGER NOT NULL DEFAULT 1,
    resume_phase TEXT NOT NULL DEFAULT 'initial',
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS discussion_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    cause TEXT NOT NULL,
    participant TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('host','expert')),
    turn_id INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','dispatched','started','completed','cancelled','failed')),
    token_hash TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    lease_until INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(room_id,run_id,generation,cause)
);
CREATE INDEX IF NOT EXISTS events_room_cursor ON discussion_events(room_id,id);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_execution ON discussion_events(room_id)
    WHERE status IN ('dispatched','started');
-- Stage timestamps for the progress panel; old events simply have no timing row.
CREATE TABLE IF NOT EXISTS event_timings (
    event_id INTEGER PRIMARY KEY REFERENCES discussion_events(id) ON DELETE CASCADE,
    dispatched_at INTEGER NOT NULL DEFAULT 0,
    finished_at INTEGER NOT NULL DEFAULT 0
);
-- Freeze dispatch-to-publication time independently of the recent execution list.
CREATE TABLE IF NOT EXISTS message_timings (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    elapsed_seconds INTEGER NOT NULL CHECK(elapsed_seconds>=0)
);
-- Only completed expert events identify a historical message unambiguously.
INSERT INTO message_timings(message_id,elapsed_seconds)
    SELECT m.id,MAX(0,CAST(strftime('%s',m.created_at) AS INTEGER)-t.dispatched_at)
    FROM messages AS m JOIN discussion_events AS e
        ON e.room_id=m.room_id AND e.result='message:'||m.id AND e.participant=m.author
    JOIN event_timings AS t ON t.event_id=e.id
    WHERE m.source IN ('cli','api') AND e.role='expert' AND e.status='completed'
        AND e.started_at>0 AND t.dispatched_at>0 AND t.finished_at>0
    ON CONFLICT(message_id) DO NOTHING;
CREATE TRIGGER IF NOT EXISTS record_event_timing AFTER UPDATE OF status ON discussion_events
WHEN OLD.status<>NEW.status
BEGIN
    -- Avoid OR IGNORE: an outer statement's conflict policy would override it.
    INSERT INTO event_timings(event_id) SELECT NEW.id
        WHERE NOT EXISTS(SELECT 1 FROM event_timings WHERE event_id=NEW.id);
    UPDATE event_timings SET dispatched_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE event_id=NEW.id AND NEW.status='dispatched';
    UPDATE event_timings SET finished_at=CAST(strftime('%s','now') AS INTEGER)
        WHERE event_id=NEW.id AND NEW.status IN ('completed','cancelled','failed');
END;
-- A failed assertion rolls back the whole D1 batch, including concurrent writes.
CREATE TABLE IF NOT EXISTS runtime_assertions (
    id TEXT PRIMARY KEY, allowed INTEGER NOT NULL CHECK(allowed=1)
);
CREATE TRIGGER IF NOT EXISTS runtime_generation AFTER UPDATE ON discussion_runtime
WHEN OLD.generation<>NEW.generation OR OLD.status<>NEW.status
BEGIN
    UPDATE discussion_events SET status='cancelled' WHERE room_id=NEW.room_id
        AND status IN ('pending','dispatched','started')
        AND (generation<>NEW.generation OR NEW.status<>'running');
    INSERT OR IGNORE INTO discussion_events(room_id,run_id,generation,cause,participant,role,turn_id)
        SELECT NEW.room_id,NEW.run_id,NEW.generation,'start:'||NEW.generation,
            COALESCE(turns.expert,settings.host),CASE WHEN turns.id IS NULL THEN 'host' ELSE 'expert' END,turns.id
        FROM topic_settings AS settings LEFT JOIN discussion_turns AS turns
            ON turns.room_id=settings.room_id AND turns.status IN ('pending','notified')
        WHERE settings.room_id=NEW.room_id AND NEW.status='running';
END;
DROP TRIGGER IF EXISTS runtime_turn_created;
CREATE TRIGGER runtime_turn_created AFTER INSERT ON discussion_turns
WHEN NEW.status<>'queued'
BEGIN
    UPDATE discussion_events SET status='completed',result='turn:'||NEW.id
        WHERE room_id=NEW.room_id AND role='host' AND status IN ('pending','dispatched','started');
    INSERT OR IGNORE INTO discussion_events(room_id,run_id,generation,cause,participant,role,turn_id)
        SELECT NEW.room_id,run_id,generation,'turn:'||NEW.id,NEW.expert,'expert',NEW.id
        FROM discussion_runtime WHERE room_id=NEW.room_id AND status='running';
END;
-- Round plans: queued turns wait in id order. held_since marks the first unprocessed user action
-- (a message id, or the next id for a topic edit); while set, answers return to the host instead of relaying.
CREATE TABLE IF NOT EXISTS turn_relay (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    held_since INTEGER NOT NULL DEFAULT 0
);
-- Both triggers below clear the hold only when no user message arrived after the running host execution began; the host cannot have read it.
DROP TRIGGER IF EXISTS relay_turn_promoted;
CREATE TRIGGER relay_turn_promoted AFTER UPDATE OF status ON discussion_turns
WHEN OLD.status='queued' AND NEW.status='pending'
BEGIN
    UPDATE room_floor SET holder=NULL,next_speaker=NEW.expert,revision=revision+1 WHERE room_id=NEW.room_id;
    UPDATE turn_relay SET held_since=0 WHERE room_id=NEW.room_id
        AND NOT EXISTS(SELECT 1 FROM messages m JOIN discussion_events e ON e.room_id=m.room_id AND e.role='host' AND e.status='started'
        WHERE m.room_id=NEW.room_id AND m.author='用户' AND CAST(strftime('%s',m.created_at) AS INTEGER)>e.started_at);
    UPDATE discussion_events SET status='completed',result='turn:'||NEW.id
        WHERE room_id=NEW.room_id AND role='host' AND status IN ('pending','dispatched','started');
    INSERT OR IGNORE INTO discussion_events(room_id,run_id,generation,cause,participant,role,turn_id)
        SELECT NEW.room_id,run_id,generation,'turn:'||NEW.id,NEW.expert,'expert',NEW.id
        FROM discussion_runtime WHERE room_id=NEW.room_id AND status='running';
END;
-- A new arrangement is the host's response: it replaces any older plan and clears the hold.
DROP TRIGGER IF EXISTS relay_plan_replaced;
CREATE TRIGGER relay_plan_replaced AFTER INSERT ON discussion_turns
WHEN NEW.status<>'queued'
BEGIN
    UPDATE discussion_turns SET status='skipped' WHERE room_id=NEW.room_id AND status='queued' AND id<NEW.id;
    UPDATE turn_relay SET held_since=0 WHERE room_id=NEW.room_id
        AND NOT EXISTS(SELECT 1 FROM messages m JOIN discussion_events e ON e.room_id=m.room_id AND e.role='host' AND e.status='started'
        WHERE m.room_id=NEW.room_id AND m.author='用户' AND CAST(strftime('%s',m.created_at) AS INTEGER)>e.started_at);
END;
CREATE TRIGGER IF NOT EXISTS relay_hold_user_message AFTER INSERT ON message_details
WHEN EXISTS(SELECT 1 FROM messages WHERE id=NEW.message_id AND author='用户')
BEGIN
    INSERT INTO turn_relay(room_id) SELECT room_id FROM messages WHERE id=NEW.message_id
        AND NOT EXISTS(SELECT 1 FROM turn_relay WHERE turn_relay.room_id=messages.room_id);
    UPDATE turn_relay SET held_since=NEW.message_id
        WHERE room_id=(SELECT room_id FROM messages WHERE id=NEW.message_id) AND held_since=0;
END;
CREATE TRIGGER IF NOT EXISTS relay_hold_goal AFTER UPDATE OF goal ON rooms
WHEN NEW.goal<>OLD.goal
BEGIN
    INSERT INTO turn_relay(room_id) SELECT NEW.id WHERE NOT EXISTS(SELECT 1 FROM turn_relay WHERE room_id=NEW.id);
    UPDATE turn_relay SET held_since=(SELECT COALESCE(MAX(id),0)+1 FROM messages WHERE room_id=NEW.id)
        WHERE room_id=NEW.id AND held_since=0;
END;
CREATE TRIGGER IF NOT EXISTS relay_hold_topic AFTER UPDATE OF background,boundaries,focus ON topic_settings
WHEN NEW.background<>OLD.background OR NEW.boundaries<>OLD.boundaries OR NEW.focus<>OLD.focus
BEGIN
    INSERT INTO turn_relay(room_id) SELECT NEW.room_id WHERE NOT EXISTS(SELECT 1 FROM turn_relay WHERE room_id=NEW.room_id);
    UPDATE turn_relay SET held_since=(SELECT COALESCE(MAX(id),0)+1 FROM messages WHERE room_id=NEW.room_id)
        WHERE room_id=NEW.room_id AND held_since=0;
END;
-- Concluding, replacing the host or removing/changing an expert voids plans that have not started.
-- Adding experts preserves the current plan; the invitation transaction appends their opening turns.
CREATE TRIGGER IF NOT EXISTS relay_plan_concluded AFTER UPDATE OF phase ON topic_settings
WHEN NEW.phase='concluded'
BEGIN
    UPDATE discussion_turns SET status='skipped' WHERE room_id=NEW.room_id AND status='queued';
END;
DROP TRIGGER IF EXISTS relay_plan_participants;
CREATE TRIGGER relay_plan_participants AFTER UPDATE OF host,experts ON topic_settings
WHEN NEW.host<>OLD.host OR EXISTS (
    SELECT 1 FROM json_each(OLD.experts) AS previous
    WHERE NOT EXISTS (SELECT 1 FROM json_each(NEW.experts) AS current
                      WHERE current.key=previous.key AND current.value=previous.value)
)
BEGIN
    UPDATE discussion_turns SET status='skipped' WHERE room_id=NEW.room_id AND status='queued';
END;
DROP TRIGGER IF EXISTS runtime_turn_answered;
-- An answer relays to the next queued turn unless the user has acted since the host last arranged.
CREATE TRIGGER runtime_turn_answered AFTER UPDATE OF status ON discussion_turns
WHEN NEW.status='answered' AND OLD.status<>'answered'
BEGIN
    UPDATE discussion_events SET status='completed',result='message:'||NEW.answer_id
        WHERE room_id=NEW.room_id AND turn_id=NEW.id AND status IN ('pending','dispatched','started');
    UPDATE discussion_turns SET status='pending'
        WHERE id=(SELECT MIN(id) FROM discussion_turns WHERE room_id=NEW.room_id AND status='queued')
        AND NOT EXISTS(SELECT 1 FROM turn_relay WHERE room_id=NEW.room_id AND held_since>0)
        AND NOT EXISTS(SELECT 1 FROM topic_settings WHERE room_id=NEW.room_id AND phase IN ('paused','concluded'));
    INSERT OR IGNORE INTO discussion_events(room_id,run_id,generation,cause,participant,role)
        SELECT NEW.room_id,run_id,generation,'answer:'||NEW.id,host,'host'
        FROM discussion_runtime JOIN topic_settings USING(room_id)
        WHERE room_id=NEW.room_id AND status='running'
        AND NOT EXISTS(SELECT 1 FROM discussion_turns WHERE room_id=NEW.room_id AND status IN ('pending','notified'));
END;
DROP TRIGGER IF EXISTS runtime_topic_stop;
CREATE TRIGGER runtime_topic_stop AFTER UPDATE OF phase ON topic_settings
WHEN NEW.phase IN ('paused','concluded') AND OLD.phase<>NEW.phase
BEGIN
    UPDATE discussion_events SET status='completed',result='concluded' WHERE room_id=NEW.room_id
        AND role='host' AND status='started' AND NEW.phase='concluded';
    UPDATE discussion_runtime SET status=NEW.phase,generation=generation+1,revision=revision+1,
        resume_phase=CASE WHEN OLD.phase IN ('initial','discussing','reviewing') THEN OLD.phase ELSE resume_phase END,
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE room_id=NEW.room_id;
END;
CREATE TRIGGER IF NOT EXISTS runtime_user_message AFTER INSERT ON message_details
WHEN EXISTS(SELECT 1 FROM messages WHERE id=NEW.message_id AND author='用户')
BEGIN
    INSERT OR IGNORE INTO discussion_events(room_id,run_id,generation,cause,participant,role)
        SELECT messages.room_id,run_id,generation,'user:'||NEW.message_id,host,'host'
        FROM messages JOIN discussion_runtime ON discussion_runtime.room_id=messages.room_id
        JOIN topic_settings ON topic_settings.room_id=messages.room_id
        WHERE messages.id=NEW.message_id AND status='running';
END;
CREATE TRIGGER IF NOT EXISTS runtime_turn_cancelled AFTER UPDATE OF status ON discussion_turns
WHEN NEW.status='cancelled' AND OLD.status<>'cancelled'
BEGIN
    UPDATE discussion_events SET status='cancelled' WHERE room_id=NEW.room_id AND turn_id=NEW.id
        AND status IN ('pending','dispatched','started');
    INSERT OR IGNORE INTO discussion_events(room_id,run_id,generation,cause,participant,role)
        SELECT NEW.room_id,run_id,generation,'cancel:'||NEW.id,host,'host'
        FROM discussion_runtime JOIN topic_settings USING(room_id)
        WHERE room_id=NEW.room_id AND status='running'
        AND NOT EXISTS(SELECT 1 FROM discussion_events WHERE room_id=NEW.room_id AND role='host' AND status='started');
END;
CREATE TRIGGER IF NOT EXISTS runtime_archive AFTER UPDATE OF archived ON room_directory
WHEN NEW.archived=1 AND OLD.archived<>NEW.archived
BEGIN
    UPDATE discussion_runtime SET status='stopped',generation=generation+1,revision=revision+1
        WHERE room_id=NEW.room_id;
END;
DROP TRIGGER IF EXISTS runtime_participants_changed;
-- A new host needs a new run. Experts joining or leaving keep the run going; the host is woken to re-plan.
CREATE TRIGGER runtime_participants_changed AFTER UPDATE OF host ON topic_settings
WHEN NEW.host<>OLD.host
BEGIN
    UPDATE discussion_runtime SET status='paused',generation=generation+1,revision=revision+1
        WHERE room_id=NEW.room_id AND status='running';
END;
DROP TRIGGER IF EXISTS runtime_experts_changed;
CREATE TRIGGER runtime_experts_changed AFTER UPDATE OF experts ON topic_settings
WHEN NEW.host=OLD.host AND NEW.experts<>OLD.experts
BEGIN
    INSERT OR IGNORE INTO discussion_events(room_id,run_id,generation,cause,participant,role)
        SELECT NEW.room_id,run_id,generation,'members:'||COALESCE((SELECT MAX(id) FROM discussion_events),0),NEW.host,'host'
        FROM discussion_runtime WHERE room_id=NEW.room_id AND status='running'
        AND NOT EXISTS(SELECT 1 FROM discussion_events WHERE room_id=NEW.room_id AND role='host' AND status IN ('pending','dispatched','started'))
        AND NOT EXISTS(SELECT 1 FROM discussion_turns WHERE room_id=NEW.room_id AND status IN ('pending','notified'));
END;
CREATE TRIGGER IF NOT EXISTS runtime_goal_changed AFTER UPDATE OF goal ON rooms
WHEN NEW.goal<>OLD.goal
BEGIN
    INSERT OR IGNORE INTO discussion_events(room_id,run_id,generation,cause,participant,role)
        SELECT NEW.id,run_id,generation,'goal:'||COALESCE((SELECT MAX(id) FROM discussion_events),0),host,'host'
        FROM discussion_runtime JOIN topic_settings USING(room_id)
        WHERE room_id=NEW.id AND status='running'
        AND NOT EXISTS(SELECT 1 FROM discussion_events WHERE room_id=NEW.id AND role='host' AND status='started');
END;
CREATE TRIGGER IF NOT EXISTS runtime_constraints_changed AFTER UPDATE OF background,boundaries ON topic_settings
WHEN NEW.background<>OLD.background OR NEW.boundaries<>OLD.boundaries
BEGIN
    INSERT OR IGNORE INTO discussion_events(room_id,run_id,generation,cause,participant,role)
        SELECT NEW.room_id,run_id,generation,'constraints:'||COALESCE((SELECT MAX(id) FROM discussion_events),0),NEW.host,'host'
        FROM discussion_runtime WHERE room_id=NEW.room_id AND status='running'
        AND NOT EXISTS(SELECT 1 FROM discussion_events WHERE room_id=NEW.room_id AND role='host' AND status='started');
END;
-- Paused, preparing or concluded time is idle: it is excluded from elapsed time and total-duration deadlines.
CREATE TABLE IF NOT EXISTS discussion_pauses (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    paused_at INTEGER NOT NULL DEFAULT 0,
    paused_seconds INTEGER NOT NULL DEFAULT 0
);
INSERT INTO discussion_pauses(room_id,paused_at)
    SELECT room_id,CASE WHEN phase IN ('paused','concluded') THEN COALESCE((SELECT CAST(strftime('%s',updated_at) AS INTEGER)
        FROM discussion_runtime WHERE discussion_runtime.room_id=topic_settings.room_id AND status<>'running'),
        CAST(strftime('%s','now') AS INTEGER)) ELSE 0 END
    FROM topic_settings WHERE NOT EXISTS(SELECT 1 FROM discussion_pauses WHERE discussion_pauses.room_id=topic_settings.room_id);
CREATE TRIGGER IF NOT EXISTS pause_clock_stopped AFTER UPDATE OF phase ON topic_settings
WHEN OLD.phase IN ('initial','discussing','reviewing') AND NEW.phase NOT IN ('initial','discussing','reviewing')
BEGIN
    INSERT INTO discussion_pauses(room_id) SELECT NEW.room_id
        WHERE NOT EXISTS(SELECT 1 FROM discussion_pauses WHERE room_id=NEW.room_id);
    UPDATE discussion_pauses SET paused_at=CAST(strftime('%s','now') AS INTEGER) WHERE room_id=NEW.room_id AND paused_at=0;
END;
CREATE TRIGGER IF NOT EXISTS pause_clock_resumed AFTER UPDATE OF phase ON topic_settings
WHEN NEW.phase IN ('initial','discussing','reviewing') AND OLD.phase NOT IN ('initial','discussing','reviewing')
BEGIN
    UPDATE discussion_pauses SET paused_seconds=paused_seconds+MAX(0,CAST(strftime('%s','now') AS INTEGER)-paused_at),paused_at=0
        WHERE room_id=NEW.room_id AND paused_at>0;
END;
-- Both room kinds register members; free rooms additionally persist requests and executions.
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
CREATE UNIQUE INDEX IF NOT EXISTS member_name ON room_members(room_id,name) WHERE status<>'removed';
CREATE UNIQUE INDEX IF NOT EXISTS member_credential ON room_members(room_id,token_hash);
-- A manual member's own software session, reported by its CLI on posting; the local service uses it to take the member over.
CREATE TABLE IF NOT EXISTS member_sessions (
    member_id INTEGER PRIMARY KEY REFERENCES room_members(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    client TEXT NOT NULL
);
-- A manual member's own registration; it is bound to the credential it used, so a re-issued credential must register again.
CREATE TABLE IF NOT EXISTS member_registrations (
    member_id INTEGER PRIMARY KEY REFERENCES room_members(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    registered_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS member_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
    client_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'dispatched'
        CHECK(status IN ('dispatched','started','completed','cancelled','failed')),
    session_id TEXT NOT NULL DEFAULT '',
    lease_until INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    finished_at INTEGER NOT NULL DEFAULT 0,
    result TEXT NOT NULL DEFAULT '',
    changes TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    UNIQUE(room_id,client_id)
);
-- One live execution per member: different members may run in parallel, one session never twice.
CREATE UNIQUE INDEX IF NOT EXISTS one_member_execution ON member_executions(member_id)
    WHERE status IN ('dispatched','started');
CREATE TABLE IF NOT EXISTS member_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','delivering','completed','cancelled','failed')),
    execution_id INTEGER REFERENCES member_executions(id),
    answer_id INTEGER REFERENCES messages(id),
    created_at INTEGER NOT NULL,
    chain_id INTEGER NOT NULL DEFAULT 0,
    batch_id INTEGER NOT NULL DEFAULT 0,
    purpose TEXT NOT NULL DEFAULT 'ask',
    created_by TEXT NOT NULL DEFAULT 'user',
    UNIQUE(message_id,member_id)
);
CREATE INDEX IF NOT EXISTS member_requests_open ON member_requests(member_id,status);
-- Discussion options chosen at creation. A room without a row predates the option and keeps named follow-ups.
CREATE TABLE IF NOT EXISTS discussion_options (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    named_followup INTEGER NOT NULL DEFAULT 0 CHECK(named_followup IN (0,1))
);
-- Program-controlled round budget: rounds are expert opinions per active expert counted from `base`, so a roster that skips
-- someone cannot stall the limit. `cap` is the current segment's round limit (0 = discussion_limits.max_rounds); `extra` is the
-- total rounds the user appended. A room without a row predates the budget and keeps the per-roster round count.
CREATE TABLE IF NOT EXISTS round_budgets (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    base INTEGER NOT NULL DEFAULT 0,
    cap INTEGER NOT NULL DEFAULT 0,
    extra INTEGER NOT NULL DEFAULT 0
);
-- Visible record of each smart-scheduling decision in a discussion; it is not a message and moves no round or floor.
CREATE TABLE IF NOT EXISTS scheduler_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    after_message_id INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL CHECK(kind IN ('interjection','round')),
    label TEXT NOT NULL,
    confidence REAL,
    applied INTEGER NOT NULL DEFAULT 0 CHECK(applied IN (0,1)),
    provider TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduler_decisions_room ON scheduler_decisions(room_id,id);
-- What the decision model was asked and chose, shown folded under the decision; not part of backups.
CREATE TABLE IF NOT EXISTS scheduler_decision_details (
    decision_id INTEGER PRIMARY KEY REFERENCES scheduler_decisions(id) ON DELETE CASCADE,
    detail TEXT NOT NULL
);
-- Smart scheduling's suggestion that another member answer an unnamed message. The host keeps the message;
-- the user may adopt before expires_at (waiting until the host's request ends for mode 'after'), otherwise it lapses.
CREATE TABLE IF NOT EXISTS member_recommendations (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    confidence REAL NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','waiting','adopted')),
    mode TEXT NOT NULL DEFAULT ''
);
-- Ordinary members can suggest a response without creating work or spending a chain budget.
CREATE TABLE IF NOT EXISTS member_suggestions (
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES room_members(id) ON DELETE CASCADE,
    PRIMARY KEY (message_id,member_id)
);
-- A host's dispatch: its named requests form one batch that hands back to the host once.
CREATE TABLE IF NOT EXISTS free_batches (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    batch_id INTEGER NOT NULL,
    chain_id INTEGER NOT NULL,
    host_id INTEGER NOT NULL,
    settled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id,batch_id)
);
-- Chains whose automatic progress stopped (budget reached or every dispatched member failed).
CREATE TABLE IF NOT EXISTS free_chains (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    chain_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (room_id,chain_id)
);
-- A brainstorm room started from a free room keeps its origin for the way back.
CREATE TABLE IF NOT EXISTS room_links (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);
