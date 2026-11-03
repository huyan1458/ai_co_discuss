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
    experts TEXT NOT NULL, focus TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS message_details (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id),
    kind TEXT NOT NULL DEFAULT 'opinion', submitted_by TEXT NOT NULL
);
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
-- One-time registration token from `codiscuss token` on the deploying computer; cleared once the administrator registers.
CREATE TABLE IF NOT EXISTS admin_setup (
    id INTEGER PRIMARY KEY CHECK(id=1),
    token_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Every room is a free collaboration room; a discussion is a session inside it. Holds the owner's control hash.
CREATE TABLE IF NOT EXISTS room_modes (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode='free'),
    control_hash TEXT NOT NULL DEFAULT ''
);

-- A room's limits for its next discussion, set at creation or in the topic while no discussion is open; a started
-- discussion copies them into session_limits.
CREATE TABLE IF NOT EXISTS discussion_limits (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    max_rounds INTEGER NOT NULL DEFAULT 0,
    max_minutes INTEGER NOT NULL DEFAULT 0,
    execution_minutes INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO discussion_limits(room_id,execution_minutes) SELECT id,0 FROM rooms;
DROP TRIGGER IF EXISTS limits_room_created;
CREATE TRIGGER limits_room_created AFTER INSERT ON rooms
BEGIN
    INSERT INTO discussion_limits(room_id,execution_minutes) VALUES (NEW.id,0);
END;
-- Freeze dispatch-to-publication time independently of the recent execution list.
CREATE TABLE IF NOT EXISTS message_timings (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    elapsed_seconds INTEGER NOT NULL CHECK(elapsed_seconds>=0)
);
-- A failed assertion rolls back the whole D1 batch, including concurrent writes.
CREATE TABLE IF NOT EXISTS runtime_assertions (
    id TEXT PRIMARY KEY, allowed INTEGER NOT NULL CHECK(allowed=1)
);
-- Triggers of the retired discussion-room model (speaking floor, turns, relay, room-scoped runtime and phase).
-- Dropped on every start so an older database stops enforcing them; its leftover tables are removed by
-- migrations/drop_legacy_discussion.sql.
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
-- Room members; their requests and executions follow.
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

-- Local service attestation, never a permission grant. Re-imported rooms require a fresh attestation.
CREATE TABLE IF NOT EXISTS member_review_capabilities (
    member_id INTEGER PRIMARY KEY REFERENCES room_members(id) ON DELETE CASCADE,
    member_revision TEXT NOT NULL,
    config_version TEXT NOT NULL,
    adapter TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    generation INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS invalidate_member_review_capability
AFTER UPDATE OF token_hash,status,adapter,access,session_mode ON room_members
WHEN NEW.token_hash<>OLD.token_hash OR NEW.status<>OLD.status OR NEW.adapter<>OLD.adapter
    OR NEW.access<>OLD.access OR NEW.session_mode<>OLD.session_mode
BEGIN
    INSERT INTO member_review_capabilities(member_id,member_revision,config_version,adapter,recorded_at,generation)
        VALUES(NEW.id,'','',NEW.adapter,0,1)
        ON CONFLICT(member_id) DO UPDATE SET member_revision='',config_version='',generation=generation+1;
END;
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
-- Marks members of the retired web-relay access; no new rows are written.
CREATE TABLE IF NOT EXISTS member_manual_sources (
    member_id INTEGER PRIMARY KEY REFERENCES room_members(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK(source='web')
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
    activity TEXT NOT NULL DEFAULT '',
    activity_at INTEGER NOT NULL DEFAULT 0,
    UNIQUE(room_id,client_id)
);
-- What the owner wrote about each member (strengths, division of work), by name so it survives leaving and rejoining.
CREATE TABLE IF NOT EXISTS member_descriptions (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,name)
);
-- Display labels the owner gave members (e.g. from a named preset); screens show them, the name stays the identity.
CREATE TABLE IF NOT EXISTS member_labels (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    label TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(room_id,name)
);
-- Progress notes the runner saw a member's software write between tool calls; numbered per execution so a retried renewal adds nothing.
CREATE TABLE IF NOT EXISTS execution_notes (
    execution_id INTEGER NOT NULL REFERENCES member_executions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(execution_id,seq)
);
-- Operations a member's software refused without asking, since a headless run cannot ask for approval; reported once by the
-- runner after the process ends, as a JSON list of {tool, detail, rule}, so the owner can see and allow them.
CREATE TABLE IF NOT EXISTS execution_denials (
    execution_id INTEGER PRIMARY KEY REFERENCES member_executions(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    denials TEXT NOT NULL
);
-- A manual member's session refused a delivery: the runner keeps the execution and delivers again at retry_at
-- (0 while delivering). The owner may ask for it now or stop it, and the runner then fails it. Not part of backups.
CREATE TABLE IF NOT EXISTS execution_retries (
    execution_id INTEGER PRIMARY KEY REFERENCES member_executions(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    attempt INTEGER NOT NULL,
    retry_at INTEGER NOT NULL DEFAULT 0,
    reason TEXT NOT NULL DEFAULT '',
    stopped INTEGER NOT NULL DEFAULT 0
);
-- Phases the runner saw a member's software go through in one execution, as
-- millisecond offsets from its delivery; numbered per execution, and a resent segment keeps the later end. Not part of backups.
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
CREATE INDEX IF NOT EXISTS execution_segments_room ON execution_segments(room_id);
-- One live execution per member: different members may run in parallel, one session never twice.
CREATE UNIQUE INDEX IF NOT EXISTS one_member_execution ON member_executions(member_id)
    WHERE status IN ('dispatched','started');
CREATE INDEX IF NOT EXISTS member_executions_member ON member_executions(member_id);
-- The client-id uniqueness index cannot satisfy ORDER BY id LIMIT on a room's history.
CREATE INDEX IF NOT EXISTS member_executions_room_recent ON member_executions(room_id,id);
CREATE INDEX IF NOT EXISTS member_executions_room_changes ON member_executions(room_id,id) WHERE changes<>'';
CREATE INDEX IF NOT EXISTS member_executions_room_live ON member_executions(room_id,id) WHERE status IN ('dispatched','started');
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
CREATE INDEX IF NOT EXISTS member_requests_execution ON member_requests(execution_id);
CREATE INDEX IF NOT EXISTS member_requests_room ON member_requests(room_id);
CREATE INDEX IF NOT EXISTS member_requests_room_status ON member_requests(room_id,status);
CREATE INDEX IF NOT EXISTS member_requests_batch ON member_requests(batch_id,status);
-- Web chatbots are no longer members: earlier ones are removed and their open requests cancelled; their messages keep
-- the author name. member_manual_sources stays only to recognise those earlier members.
UPDATE member_requests SET status='cancelled' WHERE status IN ('pending','delivering') AND member_id IN (
    SELECT member_id FROM member_manual_sources UNION SELECT id FROM room_members WHERE access='online');
INSERT OR IGNORE INTO member_manual_sources (member_id,source) SELECT id,'web' FROM room_members WHERE access='online';
UPDATE room_members SET access='manual' WHERE access='online';
UPDATE room_members SET status='removed',role='member' WHERE status<>'removed' AND id IN (SELECT member_id FROM member_manual_sources);
-- One durable disposition per @everyone message; also prevents a host fallback from being routed again after restart.
-- The original group request may be deleted for a sequential queue, so request_id is a receipt, not a foreign key.
CREATE TABLE IF NOT EXISTS group_routes (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    request_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('all','sequential','host'))
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
-- The owner's verdict on one decision; a 'bad' one may also say who should have answered and why.
-- Kept apart from the decision so older databases need no column change.
CREATE TABLE IF NOT EXISTS scheduler_feedback (
    decision_id INTEGER PRIMARY KEY REFERENCES scheduler_decisions(id) ON DELETE CASCADE,
    rating TEXT NOT NULL CHECK(rating IN ('good','bad')),
    should_be TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
-- Messages the local service is still asking the decision model about; a transient marker, not part of backups.
CREATE TABLE IF NOT EXISTS scheduler_routing (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, message_id)
);
-- Older development databases may retain execution_deliveries; it is no longer read or written.
-- What the runner's adapter reported each execution can do (stop it, see its progress), and whether its software stopped
-- once the execution was voided: the page describes a stop as it really went (a window or App the runner cannot stop
-- keeps generating). A side table so older databases need no column change; executions are not backed up, so neither is this.
CREATE TABLE IF NOT EXISTS execution_capabilities (
    execution_id INTEGER PRIMARY KEY REFERENCES member_executions(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    stoppable INTEGER CHECK(stoppable IN (0,1)),
    progress INTEGER CHECK(progress IN (0,1)),
    stop_result TEXT NOT NULL DEFAULT '' CHECK(stop_result IN ('','stopped','unstoppable','unconfirmed'))
);
-- What a rewind does to each runner member's session, as its adapter reported: cut by the runner, rebuilt each time
-- (fresh), or kept as it is. A member without a report is kept; manual and online members are always kept.
CREATE TABLE IF NOT EXISTS member_capabilities (
    member_id INTEGER PRIMARY KEY REFERENCES room_members(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    rewind TEXT NOT NULL CHECK(rewind IN ('cut','fresh','kept'))
);
-- What a member submitted for an execution the user had already voided. Refused as an answer, so it never joins the
-- transcript or AI reads; kept so the page can show the late work folded, and so a member the runner could not stop
-- is known to have finished that turn. One per execution; not backed up, like executions.
CREATE TABLE IF NOT EXISTS late_answers (
    execution_id INTEGER PRIMARY KEY REFERENCES member_executions(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
-- Why a request was cancelled; a side table so older databases need no column change. Requests cancelled before it existed have no row.
CREATE TABLE IF NOT EXISTS request_cancel_reasons (
    request_id INTEGER PRIMARY KEY REFERENCES member_requests(id) ON DELETE CASCADE,
    reason TEXT NOT NULL CHECK(reason IN ('user_stop','member_away','member_removed','rerouted','no_reply','archived'))
);
-- Messages the owner took back: a retracted one no member began to handle, or the history a rewind returned to before.
-- AI readers no longer see them; the page keeps each in place. No room column, so it never clashes with messages.room_id in joins.
CREATE TABLE IF NOT EXISTS message_withdrawals (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK(kind IN ('retracted','rewound')),
    created_at INTEGER NOT NULL
);
-- An indexed room lookup without adding a room_id column that would make existing message joins ambiguous.
CREATE TABLE IF NOT EXISTS message_withdrawal_rooms (
    message_id INTEGER PRIMARY KEY REFERENCES message_withdrawals(message_id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS message_withdrawal_rooms_room ON message_withdrawal_rooms(room_id,message_id);
INSERT INTO message_withdrawal_rooms(message_id,room_id)
    SELECT w.message_id,m.room_id FROM message_withdrawals w JOIN messages m ON m.id=w.message_id
    WHERE NOT EXISTS(SELECT 1 FROM message_withdrawal_rooms r WHERE r.message_id=w.message_id);
CREATE TRIGGER IF NOT EXISTS withdrawal_room_insert AFTER INSERT ON message_withdrawals
BEGIN
    INSERT INTO message_withdrawal_rooms(message_id,room_id) SELECT NEW.message_id,room_id FROM messages WHERE id=NEW.message_id;
END;
CREATE TRIGGER IF NOT EXISTS withdrawal_room_move AFTER UPDATE OF room_id ON messages
BEGIN
    UPDATE message_withdrawal_rooms SET room_id=NEW.room_id WHERE message_id=NEW.id;
END;
-- Each rewind and, per member id, the executions it took back (JSON {member id: [execution ids]}): before the member's next
-- execution the runner cuts its session before the earliest of them it finds. Not part of backups, since executions are not.
CREATE TABLE IF NOT EXISTS room_rewinds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    cuts TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
-- What produced a decision (model, threshold, prompt and package versions), so ratings stay comparable across versions.
CREATE TABLE IF NOT EXISTS scheduler_decision_context (
    decision_id INTEGER PRIMARY KEY REFERENCES scheduler_decisions(id) ON DELETE CASCADE,
    context TEXT NOT NULL
);
-- The exact input the decision model saw (state and full questions with option descriptions); not part of backups.
CREATE TABLE IF NOT EXISTS scheduler_decision_inputs (
    decision_id INTEGER PRIMARY KEY REFERENCES scheduler_decisions(id) ON DELETE CASCADE,
    input TEXT NOT NULL
);
-- A self-contained copy of each decision the owner currently rates bad, kept when its room is deleted so prompts can be reviewed.
CREATE TABLE IF NOT EXISTS scheduler_feedback_cases (
    decision_id INTEGER PRIMARY KEY,
    room_id TEXT NOT NULL,
    room_title TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    should_be TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    rated_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS member_recommendations_room ON member_recommendations(room_id,status);
CREATE INDEX IF NOT EXISTS member_recommendations_recent ON member_recommendations(room_id,message_id);
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
-- Members the user named to answer one after another, in the room's speaking order: each gets its request once the one before
-- it ends. Asked rows stay so the speaking order can show who already answered; the owner may reorder rows not yet asked.
CREATE TABLE IF NOT EXISTS free_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES room_members(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS free_queue_room ON free_queue(room_id,id);
CREATE INDEX IF NOT EXISTS free_queue_message ON free_queue(message_id,id);
-- Only not-yet-requested queue rows participate in advancement. Historical rows remain in free_queue.
CREATE TABLE IF NOT EXISTS free_queue_waiting (
    id INTEGER PRIMARY KEY REFERENCES free_queue(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL,
    member_id INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS free_queue_waiting_room ON free_queue_waiting(room_id,message_id,id);
CREATE INDEX IF NOT EXISTS free_queue_waiting_message ON free_queue_waiting(message_id,member_id);
INSERT INTO free_queue_waiting(id,room_id,message_id,member_id)
    SELECT q.id,q.room_id,q.message_id,q.member_id FROM free_queue q
    WHERE NOT EXISTS(SELECT 1 FROM member_requests r WHERE r.message_id=q.message_id AND r.member_id=q.member_id)
      AND NOT EXISTS(SELECT 1 FROM free_queue_waiting w WHERE w.id=q.id);
-- Owner messages sent while members still work wait here, in position order, and are posted one by one once the room is idle.
-- `payload` is the message as sent (submission_id included); `failure` holds why posting it failed, which holds the queue.
CREATE TABLE IF NOT EXISTS queued_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    position INTEGER NOT NULL,
    submission_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    failure TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE(room_id,submission_id)
);
CREATE INDEX IF NOT EXISTS queued_messages_room ON queued_messages(room_id,position);
-- A room's queue paused because the owner stopped members; the owner resumes it.
CREATE TABLE IF NOT EXISTS queued_message_pauses (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE
);
-- Site-wide composer behaviour: whether messages sent while members work are queued (1) or sent at once (0).
CREATE TABLE IF NOT EXISTS composer_settings (
    id INTEGER PRIMARY KEY CHECK (id=1),
    queueing INTEGER NOT NULL DEFAULT 1 CHECK (queueing IN (0,1))
);
CREATE TRIGGER IF NOT EXISTS queue_waiting_insert AFTER INSERT ON free_queue
BEGIN
    INSERT INTO free_queue_waiting(id,room_id,message_id,member_id)
        SELECT NEW.id,NEW.room_id,NEW.message_id,NEW.member_id
        WHERE NOT EXISTS(SELECT 1 FROM member_requests WHERE message_id=NEW.message_id AND member_id=NEW.member_id);
END;
CREATE TRIGGER IF NOT EXISTS queue_waiting_move AFTER UPDATE OF room_id,message_id,member_id ON free_queue
BEGIN
    DELETE FROM free_queue_waiting WHERE id=OLD.id;
    INSERT INTO free_queue_waiting(id,room_id,message_id,member_id)
        SELECT NEW.id,NEW.room_id,NEW.message_id,NEW.member_id
        WHERE NOT EXISTS(SELECT 1 FROM member_requests WHERE message_id=NEW.message_id AND member_id=NEW.member_id);
END;
CREATE TRIGGER IF NOT EXISTS queue_waiting_requested AFTER INSERT ON member_requests
BEGIN
    DELETE FROM free_queue_waiting WHERE message_id=NEW.message_id AND member_id=NEW.member_id;
END;
CREATE TRIGGER IF NOT EXISTS queue_waiting_request_deleted AFTER DELETE ON member_requests
BEGIN
    INSERT INTO free_queue_waiting(id,room_id,message_id,member_id)
        SELECT q.id,q.room_id,q.message_id,q.member_id FROM free_queue q
        WHERE q.message_id=OLD.message_id AND q.member_id=OLD.member_id
          AND NOT EXISTS(SELECT 1 FROM member_requests WHERE message_id=q.message_id AND member_id=q.member_id)
          AND NOT EXISTS(SELECT 1 FROM free_queue_waiting WHERE id=q.id);
END;
CREATE TRIGGER IF NOT EXISTS queue_waiting_request_moved AFTER UPDATE OF message_id,member_id ON member_requests
BEGIN
    DELETE FROM free_queue_waiting WHERE message_id=NEW.message_id AND member_id=NEW.member_id;
    INSERT INTO free_queue_waiting(id,room_id,message_id,member_id)
        SELECT q.id,q.room_id,q.message_id,q.member_id FROM free_queue q
        WHERE q.message_id=OLD.message_id AND q.member_id=OLD.member_id
          AND NOT EXISTS(SELECT 1 FROM member_requests WHERE message_id=q.message_id AND member_id=q.member_id)
          AND NOT EXISTS(SELECT 1 FROM free_queue_waiting WHERE id=q.id);
END;
CREATE INDEX IF NOT EXISTS free_batches_chain ON free_batches(room_id,chain_id);
CREATE INDEX IF NOT EXISTS free_batches_unsettled ON free_batches(room_id,batch_id) WHERE settled=0;
-- The owner's default speaking order (JSON list of member ids); members it lacks follow, the host first, then by joining order.
CREATE TABLE IF NOT EXISTS speaking_orders (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    member_ids TEXT NOT NULL
);
-- Chains whose automatic progress stopped (budget reached or every dispatched member failed).
CREATE TABLE IF NOT EXISTS free_chains (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    chain_id INTEGER NOT NULL,
    reason TEXT NOT NULL,
    PRIMARY KEY (room_id,chain_id)
);
-- A host's one-member dispatch that should come back to the host when it ends (several members always do).
CREATE TABLE IF NOT EXISTS free_handoffs (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    batch_id INTEGER NOT NULL,
    PRIMARY KEY (room_id,batch_id)
);
-- The owner's per-room limit on rounds a host may run from one owner message (a round is one host dispatch, its members'
-- answers and the hand-back); rooms without a row use the default.
CREATE TABLE IF NOT EXISTS free_round_limits (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    max_rounds INTEGER NOT NULL
);
-- A chain the owner let run on past its limit: the rounds added, and the dispatch the limit held back, which is sent
-- when the owner continues (message_id 0 when nothing is held).
CREATE TABLE IF NOT EXISTS free_chain_holds (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    chain_id INTEGER NOT NULL,
    extra_rounds INTEGER NOT NULL DEFAULT 0,
    message_id INTEGER NOT NULL DEFAULT 0,
    host_id INTEGER NOT NULL DEFAULT 0,
    names TEXT NOT NULL DEFAULT '[]',
    handoff INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (room_id,chain_id)
);
-- A discussion is a switch on a room, not a room type: one thin record per started discussion.
-- Session status is written by the application.
CREATE TABLE IF NOT EXISTS discussion_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'paused' CHECK(status IN ('active','paused','concluded')),
    started_message_id INTEGER NOT NULL DEFAULT 0,
    ended_message_id INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session ON discussion_sessions(room_id) WHERE status IN ('active','paused');
CREATE INDEX IF NOT EXISTS discussion_sessions_room ON discussion_sessions(room_id);
-- Historical conclusion snapshots are written by the application and remain readable across later discussions.
CREATE TABLE IF NOT EXISTS discussion_conclusions (
    session_id INTEGER PRIMARY KEY REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    stop_reason TEXT NOT NULL DEFAULT '',
    max_rounds INTEGER NOT NULL DEFAULT 0,
    max_minutes INTEGER NOT NULL DEFAULT 0,
    brief TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    state_until INTEGER NOT NULL DEFAULT 0,
    concluded_at TEXT NOT NULL
);
-- Session-scoped settings and state.
CREATE TABLE IF NOT EXISTS session_start_submissions (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    submission_id TEXT NOT NULL,
    session_id INTEGER NOT NULL UNIQUE REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    request_json TEXT NOT NULL,
    PRIMARY KEY (room_id,submission_id)
);
CREATE TABLE IF NOT EXISTS session_state (
    session_id INTEGER PRIMARY KEY REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    phase TEXT NOT NULL CHECK(phase IN ('initial','discussing')),
    revision INTEGER NOT NULL DEFAULT 0,
    read_until INTEGER NOT NULL DEFAULT 0,
    held_since INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_limits (
    session_id INTEGER PRIMARY KEY REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    max_rounds INTEGER NOT NULL DEFAULT 0,
    max_minutes INTEGER NOT NULL DEFAULT 0,
    execution_minutes INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL DEFAULT 0,
    stop_reason TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_round_budgets (
    session_id INTEGER PRIMARY KEY REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    base INTEGER NOT NULL DEFAULT 0,
    cap INTEGER NOT NULL DEFAULT 0,
    extra INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_pauses (
    session_id INTEGER PRIMARY KEY REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    paused_at INTEGER NOT NULL DEFAULT 0,
    paused_seconds INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS session_options (
    session_id INTEGER PRIMARY KEY REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    named_followup INTEGER NOT NULL DEFAULT 0 CHECK(named_followup IN (0,1))
);
CREATE TABLE IF NOT EXISTS session_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    round INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    member_id INTEGER NOT NULL REFERENCES room_members(id),
    purpose TEXT NOT NULL CHECK(purpose IN ('discuss','discuss_host')),
    question TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','open','answered','failed','skipped','cancelled')),
    member_request_id INTEGER UNIQUE REFERENCES member_requests(id),
    submission_id TEXT NOT NULL,
    read_until INTEGER DEFAULT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(session_id,submission_id)
);
CREATE INDEX IF NOT EXISTS session_requests_queue ON session_requests(session_id,status,round,position,id);
CREATE INDEX IF NOT EXISTS session_requests_rounds ON session_requests(session_id,round,position,id) WHERE purpose='discuss';
CREATE UNIQUE INDEX IF NOT EXISTS one_open_session_request ON session_requests(session_id)
    WHERE status='open' AND purpose='discuss';
CREATE TABLE IF NOT EXISTS task_message_sources (
    message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL REFERENCES discussion_sessions(id) ON DELETE CASCADE,
    session_request_id INTEGER NOT NULL UNIQUE REFERENCES session_requests(id) ON DELETE CASCADE,
    cause_kind TEXT NOT NULL CHECK(cause_kind IN ('session_started','scheduled_speaker','speaker_answered','round_complete','user_message','member_change','request_failed')),
    cause_message_id INTEGER REFERENCES messages(id),
    cause_request_id INTEGER REFERENCES member_requests(id)
);
CREATE INDEX IF NOT EXISTS task_message_sources_session ON task_message_sources(session_id,message_id);

-- One host-authorized review step for one implementation batch. Imported plans remain history only.
CREATE TABLE IF NOT EXISTS review_plans (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    batch_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    chain_id INTEGER NOT NULL,
    host_id INTEGER NOT NULL,
    reviewer_id INTEGER NOT NULL,
    reviewer_name TEXT NOT NULL,
    config_version TEXT NOT NULL,
    member_revision TEXT NOT NULL,
    scope TEXT NOT NULL,
    implementers TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','advanced','imported')),
    review_batch_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
    advance_submission TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(room_id,batch_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS review_advance_submission ON review_plans(room_id,advance_submission)
    WHERE advance_submission<>'';
-- UNION ALL (the two sources never share a message) lets SQLite push a message_id lookup into each indexed arm;
-- plain UNION materializes both tables on every lookup. Recreated on each schema run so existing databases pick it up.
DROP VIEW IF EXISTS internal_task_messages;
CREATE VIEW internal_task_messages AS
    SELECT message_id FROM task_message_sources
    UNION ALL SELECT review_batch_id AS message_id FROM review_plans WHERE review_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_plans_batch_message ON review_plans(review_batch_id);

-- Cached directory aggregates: backfill existing rooms once, then maintain them in the same write transaction.
-- Withdrawal keeps a transcript card, so it does not change these counts. Internal task/review messages do.
CREATE TABLE IF NOT EXISTS room_message_stats (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    message_count INTEGER NOT NULL DEFAULT 0,
    latest_id INTEGER NOT NULL DEFAULT 0
);
INSERT INTO room_message_stats(room_id,message_count,latest_id)
    SELECT r.id,COUNT(m.id),COALESCE(MAX(m.id),0) FROM rooms r
    LEFT JOIN messages m ON m.room_id=r.id
        AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)
    WHERE NOT EXISTS(SELECT 1 FROM room_message_stats stats WHERE stats.room_id=r.id) GROUP BY r.id;
CREATE TRIGGER IF NOT EXISTS message_stats_room AFTER INSERT ON rooms
BEGIN
    INSERT INTO room_message_stats(room_id) VALUES(NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS message_stats_insert AFTER INSERT ON messages
WHEN NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=NEW.id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count+1,latest_id=MAX(latest_id,NEW.id)
        WHERE room_id=NEW.room_id;
END;
CREATE TRIGGER IF NOT EXISTS message_stats_delete BEFORE DELETE ON messages
WHEN NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=OLD.id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count-1,
        latest_id=CASE WHEN latest_id=OLD.id THEN (SELECT COALESCE(MAX(m.id),0) FROM messages m
            WHERE m.room_id=room_message_stats.room_id AND m.id<>OLD.id AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)) ELSE latest_id END
        WHERE room_id=OLD.room_id;
END;
CREATE TRIGGER IF NOT EXISTS message_stats_move_before BEFORE UPDATE OF room_id,id ON messages
WHEN NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=OLD.id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count-1,
        latest_id=CASE WHEN latest_id=OLD.id THEN (SELECT COALESCE(MAX(m.id),0) FROM messages m
            WHERE m.room_id=room_message_stats.room_id AND m.id<>OLD.id AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)) ELSE latest_id END
        WHERE room_id=OLD.room_id;
END;
CREATE TRIGGER IF NOT EXISTS message_stats_move_after AFTER UPDATE OF room_id,id ON messages
WHEN NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=NEW.id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count+1,latest_id=MAX(latest_id,NEW.id)
        WHERE room_id=NEW.room_id;
END;
CREATE TRIGGER IF NOT EXISTS message_stats_task_insert AFTER INSERT ON task_message_sources
WHEN EXISTS(SELECT 1 FROM messages WHERE id=NEW.message_id) AND NOT EXISTS(SELECT 1 FROM review_plans WHERE review_batch_id=NEW.message_id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count-1,
        latest_id=CASE WHEN latest_id=NEW.message_id THEN (SELECT COALESCE(MAX(m.id),0) FROM messages m
            WHERE m.room_id=room_message_stats.room_id AND m.id<>NEW.message_id AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)) ELSE latest_id END
        WHERE room_id=(SELECT room_id FROM messages WHERE id=NEW.message_id);
END;
CREATE TRIGGER IF NOT EXISTS message_stats_task_delete AFTER DELETE ON task_message_sources
WHEN EXISTS(SELECT 1 FROM messages WHERE id=OLD.message_id) AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=OLD.message_id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count+1,latest_id=MAX(latest_id,OLD.message_id)
        WHERE room_id=(SELECT room_id FROM messages WHERE id=OLD.message_id);
END;
CREATE TRIGGER IF NOT EXISTS message_stats_task_update_old AFTER UPDATE OF message_id ON task_message_sources
WHEN OLD.message_id IS NOT NEW.message_id AND EXISTS(SELECT 1 FROM messages WHERE id=OLD.message_id) AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=OLD.message_id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count+1,latest_id=MAX(latest_id,OLD.message_id)
        WHERE room_id=(SELECT room_id FROM messages WHERE id=OLD.message_id);
END;
CREATE TRIGGER IF NOT EXISTS message_stats_task_update_new AFTER UPDATE OF message_id ON task_message_sources
WHEN OLD.message_id IS NOT NEW.message_id AND EXISTS(SELECT 1 FROM messages WHERE id=NEW.message_id) AND NOT EXISTS(SELECT 1 FROM review_plans WHERE review_batch_id=NEW.message_id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count-1,
        latest_id=CASE WHEN latest_id=NEW.message_id THEN (SELECT COALESCE(MAX(m.id),0) FROM messages m
            WHERE m.room_id=room_message_stats.room_id AND m.id<>NEW.message_id AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)) ELSE latest_id END
        WHERE room_id=(SELECT room_id FROM messages WHERE id=NEW.message_id);
END;
CREATE TRIGGER IF NOT EXISTS message_stats_review_insert AFTER INSERT ON review_plans
WHEN EXISTS(SELECT 1 FROM messages WHERE id=NEW.review_batch_id) AND NOT EXISTS(SELECT 1 FROM task_message_sources WHERE message_id=NEW.review_batch_id)
    AND (SELECT COUNT(*) FROM review_plans WHERE review_batch_id=NEW.review_batch_id)=1
BEGIN
    UPDATE room_message_stats SET message_count=message_count-1,
        latest_id=CASE WHEN latest_id=NEW.review_batch_id THEN (SELECT COALESCE(MAX(m.id),0) FROM messages m
            WHERE m.room_id=room_message_stats.room_id AND m.id<>NEW.review_batch_id AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)) ELSE latest_id END
        WHERE room_id=(SELECT room_id FROM messages WHERE id=NEW.review_batch_id);
END;
CREATE TRIGGER IF NOT EXISTS message_stats_review_delete AFTER DELETE ON review_plans
WHEN EXISTS(SELECT 1 FROM messages WHERE id=OLD.review_batch_id) AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=OLD.review_batch_id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count+1,latest_id=MAX(latest_id,OLD.review_batch_id)
        WHERE room_id=(SELECT room_id FROM messages WHERE id=OLD.review_batch_id);
END;
CREATE TRIGGER IF NOT EXISTS message_stats_review_update_old AFTER UPDATE OF review_batch_id ON review_plans
WHEN OLD.review_batch_id IS NOT NEW.review_batch_id AND EXISTS(SELECT 1 FROM messages WHERE id=OLD.review_batch_id) AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=OLD.review_batch_id)
BEGIN
    UPDATE room_message_stats SET message_count=message_count+1,latest_id=MAX(latest_id,OLD.review_batch_id)
        WHERE room_id=(SELECT room_id FROM messages WHERE id=OLD.review_batch_id);
END;
CREATE TRIGGER IF NOT EXISTS message_stats_review_update_new AFTER UPDATE OF review_batch_id ON review_plans
WHEN OLD.review_batch_id IS NOT NEW.review_batch_id AND EXISTS(SELECT 1 FROM messages WHERE id=NEW.review_batch_id) AND NOT EXISTS(SELECT 1 FROM task_message_sources WHERE message_id=NEW.review_batch_id)
    AND (SELECT COUNT(*) FROM review_plans WHERE review_batch_id=NEW.review_batch_id)=1
BEGIN
    UPDATE room_message_stats SET message_count=message_count-1,
        latest_id=CASE WHEN latest_id=NEW.review_batch_id THEN (SELECT COALESCE(MAX(m.id),0) FROM messages m
            WHERE m.room_id=room_message_stats.room_id AND m.id<>NEW.review_batch_id AND NOT EXISTS(SELECT 1 FROM internal_task_messages t WHERE t.message_id=m.id)) ELSE latest_id END
        WHERE room_id=(SELECT room_id FROM messages WHERE id=NEW.review_batch_id);
END;

-- Runtime idempotency receipts for converting one host interjection to an ordinary request.
CREATE TABLE IF NOT EXISTS session_ask_submissions (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    submission_id TEXT NOT NULL,
    source_request_id INTEGER NOT NULL UNIQUE REFERENCES member_requests(id) ON DELETE CASCADE,
    request_id INTEGER NOT NULL REFERENCES member_requests(id) ON DELETE CASCADE,
    PRIMARY KEY (room_id,submission_id)
);

-- A computer running the local service, paired by the site administrator. Only project names and ids and the
-- configured client of each platform are published; directories and credentials stay on that computer.
CREATE TABLE IF NOT EXISTS local_machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    projects TEXT NOT NULL DEFAULT '[]',
    clients TEXT NOT NULL DEFAULT '{}',
    seen_at INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
-- A room launch submitted from a device without the local service; the paired computer claims and runs it.
-- The request (with the room's new credentials) is cleared once the launch finishes or fails.
CREATE TABLE IF NOT EXISTS remote_launches (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    request TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done','failed')),
    result TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS remote_launches_machine ON remote_launches(machine_id, status);
-- The P-256 public key a paired computer publishes so other devices can encrypt commands only it can read.
CREATE TABLE IF NOT EXISTS machine_keys (
    machine_id TEXT PRIMARY KEY,
    public_key TEXT NOT NULL
);
-- A local-service operation relayed from a device without the local service. Request and response are end-to-end
-- encrypted between that device and the computer, so the site never holds keys, paths or results in plaintext;
-- the request is cleared once claimed and the row is deleted once read or expired.
CREATE TABLE IF NOT EXISTS machine_commands (
    id TEXT PRIMARY KEY,
    machine_id TEXT NOT NULL,
    request TEXT NOT NULL DEFAULT '{}',
    response TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','claimed','done')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS machine_commands_machine ON machine_commands(machine_id, status);

-- Change revisions, so idle rooms are not read on every poll. Every write a reader could show or act on gives its room the next
-- value of one site-wide sequence: a room's revision tells a runner or page that this room changed, and the largest revision
-- (read through the index) tells a page that anything on the site changed. The '' row stands for directory-only changes.
-- Triggers update or insert without conflicts, so an outer INSERT OR IGNORE cannot override them into skipping the bump.
CREATE TABLE IF NOT EXISTS room_revisions (
    room_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS room_revisions_order ON room_revisions(revision);
DROP TRIGGER IF EXISTS revision_message_insert;
CREATE TRIGGER revision_message_insert AFTER INSERT ON messages
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_message_update;
CREATE TRIGGER revision_message_update AFTER UPDATE ON messages
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_message_withdrawal;
CREATE TRIGGER revision_message_withdrawal AFTER INSERT ON message_withdrawals
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=(SELECT room_id FROM messages WHERE id=NEW.message_id);
    INSERT INTO room_revisions (room_id,revision) SELECT (SELECT room_id FROM messages WHERE id=NEW.message_id),(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=(SELECT room_id FROM messages WHERE id=NEW.message_id));
END;
DROP TRIGGER IF EXISTS revision_member_insert;
CREATE TRIGGER revision_member_insert AFTER INSERT ON room_members
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_member_update;
CREATE TRIGGER revision_member_update AFTER UPDATE ON room_members
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_registration_insert;
CREATE TRIGGER revision_registration_insert AFTER INSERT ON member_registrations
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_registration_update;
CREATE TRIGGER revision_registration_update AFTER UPDATE ON member_registrations
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_session_report_insert;
CREATE TRIGGER revision_session_report_insert AFTER INSERT ON member_sessions
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_session_report_update;
CREATE TRIGGER revision_session_report_update AFTER UPDATE ON member_sessions
WHEN OLD.session_id IS NOT NEW.session_id OR OLD.client IS NOT NEW.client
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_request_insert;
CREATE TRIGGER revision_request_insert AFTER INSERT ON member_requests
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_request_status;
CREATE TRIGGER revision_request_status AFTER UPDATE OF status ON member_requests
WHEN OLD.status IS NOT NEW.status
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_execution_insert;
CREATE TRIGGER revision_execution_insert AFTER INSERT ON member_executions
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_execution_status;
CREATE TRIGGER revision_execution_status AFTER UPDATE OF status ON member_executions
WHEN OLD.status IS NOT NEW.status
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
-- Non-progress execution reports must invalidate full views even without SSE. Renewals/notes stay lightweight.
CREATE TRIGGER IF NOT EXISTS revision_execution_report AFTER UPDATE OF changes,result,session_id ON member_executions
WHEN OLD.changes IS NOT NEW.changes OR OLD.result IS NOT NEW.result OR OLD.session_id IS NOT NEW.session_id
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
CREATE TRIGGER IF NOT EXISTS revision_capability_insert AFTER INSERT ON execution_capabilities
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
CREATE TRIGGER IF NOT EXISTS revision_capability_update AFTER UPDATE ON execution_capabilities
WHEN OLD.stoppable IS NOT NEW.stoppable OR OLD.progress IS NOT NEW.progress OR OLD.stop_result IS NOT NEW.stop_result
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
CREATE TRIGGER IF NOT EXISTS revision_denials_insert AFTER INSERT ON execution_denials
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
CREATE TRIGGER IF NOT EXISTS revision_late_answer AFTER INSERT ON late_answers
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_retry_insert;
CREATE TRIGGER revision_retry_insert AFTER INSERT ON execution_retries
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_retry_update;
CREATE TRIGGER revision_retry_update AFTER UPDATE ON execution_retries
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_discussion_insert;
CREATE TRIGGER revision_discussion_insert AFTER INSERT ON discussion_sessions
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_discussion_status;
CREATE TRIGGER revision_discussion_status AFTER UPDATE OF status ON discussion_sessions
WHEN OLD.status IS NOT NEW.status
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_plan_insert;
CREATE TRIGGER revision_plan_insert AFTER INSERT ON session_requests
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=(SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id);
    INSERT INTO room_revisions (room_id,revision) SELECT (SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id),(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=(SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id));
END;
DROP TRIGGER IF EXISTS revision_plan_status;
CREATE TRIGGER revision_plan_status AFTER UPDATE OF status ON session_requests
WHEN OLD.status IS NOT NEW.status
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=(SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id);
    INSERT INTO room_revisions (room_id,revision) SELECT (SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id),(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=(SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id));
END;
DROP TRIGGER IF EXISTS revision_session_phase;
CREATE TRIGGER revision_session_phase AFTER UPDATE OF phase ON session_state
WHEN OLD.phase IS NOT NEW.phase
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=(SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id);
    INSERT INTO room_revisions (room_id,revision) SELECT (SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id),(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=(SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id));
END;
DROP TRIGGER IF EXISTS revision_session_limits;
CREATE TRIGGER revision_session_limits AFTER UPDATE ON session_limits
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=(SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id);
    INSERT INTO room_revisions (room_id,revision) SELECT (SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id),(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=(SELECT room_id FROM discussion_sessions WHERE id=NEW.session_id));
END;
DROP TRIGGER IF EXISTS revision_topic_update;
CREATE TRIGGER revision_topic_update AFTER UPDATE ON topic_settings
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_brief_insert;
CREATE TRIGGER revision_brief_insert AFTER INSERT ON room_briefs
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_brief_update;
CREATE TRIGGER revision_brief_update AFTER UPDATE ON room_briefs
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_user_request_insert;
CREATE TRIGGER revision_user_request_insert AFTER INSERT ON room_user_requests
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_user_request_update;
CREATE TRIGGER revision_user_request_update AFTER UPDATE ON room_user_requests
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_decision_insert;
CREATE TRIGGER revision_decision_insert AFTER INSERT ON scheduler_decisions
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_recommendation_insert;
CREATE TRIGGER revision_recommendation_insert AFTER INSERT ON member_recommendations
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_recommendation_status;
CREATE TRIGGER revision_recommendation_status AFTER UPDATE OF status ON member_recommendations
WHEN OLD.status IS NOT NEW.status
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_description_insert;
CREATE TRIGGER revision_description_insert AFTER INSERT ON member_descriptions
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_description_update;
CREATE TRIGGER revision_description_update AFTER UPDATE ON member_descriptions
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_label_insert;
CREATE TRIGGER revision_label_insert AFTER INSERT ON member_labels
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_label_update;
CREATE TRIGGER revision_label_update AFTER UPDATE ON member_labels
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_order_insert;
CREATE TRIGGER revision_order_insert AFTER INSERT ON speaking_orders
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_order_update;
CREATE TRIGGER revision_order_update AFTER UPDATE ON speaking_orders
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_room_insert;
CREATE TRIGGER revision_room_insert AFTER INSERT ON rooms
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.id);
END;
DROP TRIGGER IF EXISTS revision_room_update;
CREATE TRIGGER revision_room_update AFTER UPDATE ON rooms
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.id);
END;
DROP TRIGGER IF EXISTS revision_room_delete;
CREATE TRIGGER revision_room_delete AFTER DELETE ON rooms
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
DROP TRIGGER IF EXISTS revision_directory_update;
CREATE TRIGGER revision_directory_update AFTER UPDATE ON room_directory
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
DROP TRIGGER IF EXISTS revision_assignment_update;
CREATE TRIGGER revision_assignment_update AFTER UPDATE ON room_folder_assignments
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
DROP TRIGGER IF EXISTS revision_folder_insert;
CREATE TRIGGER revision_folder_insert AFTER INSERT ON topic_folders
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
DROP TRIGGER IF EXISTS revision_folder_update;
CREATE TRIGGER revision_folder_update AFTER UPDATE ON topic_folders
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
DROP TRIGGER IF EXISTS revision_folder_delete;
CREATE TRIGGER revision_folder_delete AFTER DELETE ON topic_folders
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
DROP TRIGGER IF EXISTS revision_queued_message_insert;
CREATE TRIGGER revision_queued_message_insert AFTER INSERT ON queued_messages
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_queued_message_update;
CREATE TRIGGER revision_queued_message_update AFTER UPDATE ON queued_messages
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_queued_message_delete;
CREATE TRIGGER revision_queued_message_delete AFTER DELETE ON queued_messages
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=OLD.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT OLD.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=OLD.room_id);
END;
DROP TRIGGER IF EXISTS revision_queue_pause_insert;
CREATE TRIGGER revision_queue_pause_insert AFTER INSERT ON queued_message_pauses
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_queue_pause_delete;
CREATE TRIGGER revision_queue_pause_delete AFTER DELETE ON queued_message_pauses
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=OLD.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT OLD.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=OLD.room_id);
END;
DROP TRIGGER IF EXISTS revision_composer_settings_insert;
CREATE TRIGGER revision_composer_settings_insert AFTER INSERT ON composer_settings
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
DROP TRIGGER IF EXISTS revision_composer_settings_update;
CREATE TRIGGER revision_composer_settings_update AFTER UPDATE ON composer_settings
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
DROP TRIGGER IF EXISTS revision_directory_settings;
CREATE TRIGGER revision_directory_settings AFTER UPDATE ON directory_settings
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
-- The platform once called Gemini is identified as Antigravity (the software); screens still show the nickname Gemini.
-- Member names move to the new ID, with any instance suffix (Gemini-2 → Antigravity-2); names inside stored JSON follow.
-- Message text keeps what was written. Each statement only touches rows still holding the old ID, so reruns change nothing.
UPDATE room_members SET name='Antigravity'||substr(name,7) WHERE name='Gemini' OR name GLOB 'Gemini-*';
UPDATE messages SET author='Antigravity'||substr(author,7) WHERE author='Gemini' OR author GLOB 'Gemini-*';
UPDATE message_summaries SET author='Antigravity'||substr(author,7) WHERE author='Gemini' OR author GLOB 'Gemini-*';
UPDATE message_details SET submitted_by='Antigravity'||substr(submitted_by,7) WHERE submitted_by='Gemini' OR submitted_by GLOB 'Gemini-*';
UPDATE attachments SET actor='Antigravity'||substr(actor,7) WHERE actor='Gemini' OR actor GLOB 'Gemini-*';
UPDATE topic_settings SET host='Antigravity'||substr(host,7) WHERE host='Gemini' OR host GLOB 'Gemini-*';
UPDATE member_descriptions SET name='Antigravity'||substr(name,7) WHERE name='Gemini' OR name GLOB 'Gemini-*';
UPDATE member_labels SET name='Antigravity'||substr(name,7) WHERE name='Gemini' OR name GLOB 'Gemini-*';
UPDATE scheduler_feedback SET should_be='Antigravity'||substr(should_be,7) WHERE should_be='Gemini' OR should_be GLOB 'Gemini-*';
UPDATE scheduler_feedback_cases SET should_be='Antigravity'||substr(should_be,7) WHERE should_be='Gemini' OR should_be GLOB 'Gemini-*';
UPDATE review_plans SET reviewer_name='Antigravity'||substr(reviewer_name,7) WHERE reviewer_name='Gemini' OR reviewer_name GLOB 'Gemini-*';
UPDATE topic_settings SET experts=replace(replace(experts,'"Gemini"','"Antigravity"'),'"Gemini-','"Antigravity-') WHERE experts LIKE '%"Gemini%';
UPDATE free_chain_holds SET names=replace(replace(names,'"Gemini"','"Antigravity"'),'"Gemini-','"Antigravity-') WHERE names LIKE '%"Gemini%';
UPDATE room_creations SET request_text=replace(replace(request_text,'"Gemini"','"Antigravity"'),'"Gemini-','"Antigravity-') WHERE request_text LIKE '%"Gemini%';
UPDATE session_start_submissions SET request_json=replace(replace(request_json,'"Gemini"','"Antigravity"'),'"Gemini-','"Antigravity-') WHERE request_json LIKE '%"Gemini%';
UPDATE scheduler_decision_inputs SET input=replace(replace(input,'"Gemini"','"Antigravity"'),'"Gemini-','"Antigravity-') WHERE input LIKE '%"Gemini%';
