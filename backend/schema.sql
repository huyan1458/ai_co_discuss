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

DROP TRIGGER IF EXISTS reject_inactive_opinion;
CREATE TRIGGER reject_inactive_opinion BEFORE INSERT ON message_details
WHEN NEW.kind='opinion'
    AND (SELECT author FROM messages WHERE id=NEW.message_id)<>'用户'
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
-- The speaking floor is retired: the table stays only so old databases and backups load, and nothing reads or writes it.
DROP TRIGGER IF EXISTS initialize_room_floor;
DROP TRIGGER IF EXISTS transfer_host_floor;
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

-- Free collaboration rooms. Rooms without a row are brainstorm rooms and keep every rule below.
CREATE TABLE IF NOT EXISTS room_modes (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    mode TEXT NOT NULL CHECK(mode IN ('free','brainstorm')),
    control_hash TEXT NOT NULL DEFAULT ''
);
-- Replaced on every start so existing databases drop every speaking-floor rule.
DROP TRIGGER IF EXISTS require_message_floor;
DROP TRIGGER IF EXISTS return_message_floor;
DROP TRIGGER IF EXISTS require_host_floor;
DROP TRIGGER IF EXISTS nominate_expert_floor;
DROP TRIGGER IF EXISTS cancel_turn_floor;
CREATE TRIGGER IF NOT EXISTS require_opinion_turn BEFORE INSERT ON message_details
WHEN NEW.kind='opinion' AND NEW.turn_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM message_details WHERE message_id=NEW.message_id)
    AND EXISTS (SELECT 1 FROM messages WHERE id=NEW.message_id AND author<>'用户')
BEGIN
    SELECT RAISE(ABORT, 'floor_turn_required');
END;

-- Legacy room-scoped limits remain for read-only history; new discussions use session-scoped limits below.
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
DROP TRIGGER IF EXISTS limits_topic_started;
DROP TRIGGER IF EXISTS limits_phase_started;
DROP TRIGGER IF EXISTS limits_turn_started;
-- Legacy event-based orchestration tables remain for historical reads; the request-based session is authoritative.
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
DROP TRIGGER IF EXISTS record_event_timing;
-- A failed assertion rolls back the whole D1 batch, including concurrent writes.
CREATE TABLE IF NOT EXISTS runtime_assertions (
    id TEXT PRIMARY KEY, allowed INTEGER NOT NULL CHECK(allowed=1)
);
DROP TRIGGER IF EXISTS runtime_generation;
DROP TRIGGER IF EXISTS runtime_turn_created;
-- Retired relay state is preserved for old databases and historical reads only.
CREATE TABLE IF NOT EXISTS turn_relay (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    held_since INTEGER NOT NULL DEFAULT 0
);
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
DROP TRIGGER IF EXISTS pause_clock_stopped;
DROP TRIGGER IF EXISTS pause_clock_resumed;
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
-- Web-relay members use the manual access path while retaining owner-only proxy semantics.
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
-- Phases the runner saw a member's software go through in one execution (a free execution or a discussion event), as
-- millisecond offsets from its delivery; numbered per execution, and a resent segment keeps the later end. Not part of backups.
CREATE TABLE IF NOT EXISTS execution_segments (
    source TEXT NOT NULL CHECK(source IN ('free','discussion')),
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
-- Superseded by free_round_limits: it counted AI-created requests, which rose with the number of members. Kept, unread.
CREATE TABLE IF NOT EXISTS free_settings (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    max_auto_hops INTEGER NOT NULL
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
-- A brainstorm room started from a free room keeps its origin for the way back.
CREATE TABLE IF NOT EXISTS room_links (
    room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL,
    created_at TEXT NOT NULL
);

-- A discussion is a switch on a room, not a room type: one thin record per started discussion.
-- Session status is written by the application; legacy topic phase remains for old history only.
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
-- Rooms that predate sessions: every non-free room with topic settings gets one, mapped from its phase. Safe to repeat.
INSERT INTO discussion_sessions (room_id,goal,status,started_message_id,ended_message_id,created_at)
SELECT rooms.id,rooms.goal,
       CASE WHEN topic_settings.phase='concluded' THEN 'concluded' WHEN topic_settings.phase IN ('preparing','paused') THEN 'paused' ELSE 'active' END,
       0,CASE WHEN topic_settings.phase='concluded' THEN COALESCE((SELECT MAX(id) FROM messages WHERE room_id=rooms.id),0) ELSE 0 END,rooms.created_at
FROM rooms JOIN topic_settings ON topic_settings.room_id=rooms.id
WHERE NOT EXISTS (SELECT 1 FROM room_modes WHERE room_id=rooms.id AND mode='free')
  AND NOT EXISTS (SELECT 1 FROM discussion_sessions WHERE room_id=rooms.id);
DROP TRIGGER IF EXISTS session_for_new_discussion;
DROP TRIGGER IF EXISTS session_follows_phase_insert;
DROP TRIGGER IF EXISTS session_follows_phase;
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
DROP TRIGGER IF EXISTS conclusion_snapshot;
-- Discussions that ended before snapshots: only the latest still matches the room's state, so only it gets one. Safe to repeat.
INSERT OR IGNORE INTO discussion_conclusions (session_id,room_id,stop_reason,max_rounds,max_minutes,brief,state,state_until,concluded_at)
SELECT s.id,s.room_id,COALESCE(l.stop_reason,''),COALESCE(l.max_rounds,0),COALESCE(l.max_minutes,0),CASE WHEN b.until>s.started_message_id THEN b.text ELSE '' END,
           CASE WHEN r.state_until>s.started_message_id THEN r.state_text ELSE '' END,CASE WHEN r.state_until>s.started_message_id THEN r.state_until ELSE 0 END,''
FROM discussion_sessions AS s JOIN rooms AS r ON r.id=s.room_id
LEFT JOIN discussion_limits AS l ON l.room_id=s.room_id LEFT JOIN room_briefs AS b ON b.room_id=s.room_id
WHERE s.status='concluded' AND s.id=(SELECT MAX(id) FROM discussion_sessions WHERE room_id=s.room_id);

-- The review phase behaved exactly like discussing and was retired; move rows left in it.
UPDATE topic_settings SET phase='discussing' WHERE phase='reviewing';
UPDATE discussion_runtime SET resume_phase='discussing' WHERE resume_phase='reviewing';

-- Request-based sessions use session-scoped settings. The room-scoped tables above remain read-only legacy history.
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

-- Stop old engine sessions once during upgrade. Their original phase and rows remain readable, while new sessions can open.
CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
INSERT OR IGNORE INTO discussion_conclusions (session_id,room_id,stop_reason,max_rounds,max_minutes,brief,state,state_until,concluded_at)
SELECT s.id,s.room_id,'engine_upgrade',COALESCE(l.max_rounds,0),COALESCE(l.max_minutes,0),
       CASE WHEN b.until>s.started_message_id THEN b.text ELSE '' END,
       CASE WHEN r.state_until>s.started_message_id THEN r.state_text ELSE '' END,
       CASE WHEN r.state_until>s.started_message_id THEN r.state_until ELSE 0 END,
       strftime('%Y-%m-%dT%H:%M:%SZ','now')
FROM discussion_sessions AS s JOIN rooms AS r ON r.id=s.room_id
LEFT JOIN discussion_limits AS l ON l.room_id=s.room_id LEFT JOIN room_briefs AS b ON b.room_id=s.room_id
WHERE s.status IN ('active','paused')
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name='discussion_session_requests_v1');
UPDATE discussion_runtime SET status='stopped',generation=generation+1,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
WHERE status IN ('ready','running','paused')
  AND room_id IN (SELECT room_id FROM discussion_sessions WHERE status IN ('active','paused'))
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name='discussion_session_requests_v1');
UPDATE discussion_sessions SET status='concluded',
    ended_message_id=COALESCE((SELECT MAX(id) FROM messages WHERE messages.room_id=discussion_sessions.room_id),0)
WHERE status IN ('active','paused')
  AND NOT EXISTS (SELECT 1 FROM schema_migrations WHERE name='discussion_session_requests_v1');
INSERT OR IGNORE INTO schema_migrations(name) VALUES ('discussion_session_requests_v1');

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

-- Normalize legacy online relay members and retired brainstorm rooms for the shared free-room model.
INSERT OR IGNORE INTO member_manual_sources(member_id,source)
SELECT id,'web' FROM room_members WHERE access='online';
UPDATE room_members SET access='manual' WHERE access='online';
UPDATE room_modes SET mode='free' WHERE mode='brainstorm';

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
DROP TRIGGER IF EXISTS revision_free_settings_insert;
CREATE TRIGGER revision_free_settings_insert AFTER INSERT ON free_settings
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id=NEW.room_id;
    INSERT INTO room_revisions (room_id,revision) SELECT NEW.room_id,(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id=NEW.room_id);
END;
DROP TRIGGER IF EXISTS revision_free_settings_update;
CREATE TRIGGER revision_free_settings_update AFTER UPDATE ON free_settings
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
DROP TRIGGER IF EXISTS revision_directory_settings;
CREATE TRIGGER revision_directory_settings AFTER UPDATE ON directory_settings
BEGIN
    UPDATE room_revisions SET revision=(SELECT MAX(revision)+1 FROM room_revisions) WHERE room_id='';
    INSERT INTO room_revisions (room_id,revision) SELECT '',(SELECT COALESCE(MAX(revision),0)+1 FROM room_revisions)
        WHERE NOT EXISTS (SELECT 1 FROM room_revisions WHERE room_id='');
END;
