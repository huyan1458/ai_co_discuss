PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shares (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 5242880),
  revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','taken_down','reported')),
  reports INTEGER NOT NULL DEFAULT 0,
  moderation_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS shares_source_expiry ON shares(source_hash, expires_at);
CREATE INDEX IF NOT EXISTS shares_expiry ON shares(expires_at);
CREATE INDEX IF NOT EXISTS shares_updated ON shares(updated_at, id);

CREATE TABLE IF NOT EXISTS share_chunks (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 524288),
  PRIMARY KEY (share_id, position)
) WITHOUT ROWID;

-- Attachments sent as files (R2 object <share>/<revision>/<file id>); listed with the version, uploaded after it.
CREATE TABLE IF NOT EXISTS share_files (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  route TEXT NOT NULL,
  content_type TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 104857600),
  uploaded INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, route)
) WITHOUT ROWID;
-- Files of one source's live shares at most 500 MB; the whole site at most 8 GB, inside R2's free 10 GB.
CREATE TRIGGER IF NOT EXISTS share_files_quota BEFORE INSERT ON share_files BEGIN
  SELECT CASE WHEN (SELECT COALESCE(SUM(f.bytes),0) FROM share_files f JOIN shares s ON s.id=f.share_id
      WHERE s.source_hash=(SELECT source_hash FROM shares WHERE id=NEW.share_id) AND s.expires_at>(SELECT updated_at FROM shares WHERE id=NEW.share_id))+NEW.bytes>524288000
    THEN RAISE(ABORT,'share_source_quota') END;
  SELECT CASE WHEN (SELECT COALESCE(SUM(bytes),0) FROM share_files)+NEW.bytes>8000000000
    THEN RAISE(ABORT,'share_site_quota') END;
END;

CREATE TABLE IF NOT EXISTS share_reports (
  share_id TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (share_id, source_hash)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS share_rates (
  source_hash TEXT NOT NULL, action TEXT NOT NULL, hour INTEGER NOT NULL,
  total INTEGER NOT NULL CHECK (total BETWEEN 1 AND 60),
  PRIMARY KEY (source_hash, action, hour)
) WITHOUT ROWID;

-- Run quota checks in the same D1 transaction as the header and chunks.
CREATE TRIGGER IF NOT EXISTS share_insert_quota BEFORE INSERT ON shares BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM shares WHERE source_hash=NEW.source_hash AND expires_at>NEW.updated_at)>=20
    OR (SELECT COALESCE(SUM(bytes),0) FROM shares WHERE source_hash=NEW.source_hash AND expires_at>NEW.updated_at)+NEW.bytes>52428800
    THEN RAISE(ABORT,'share_source_quota') END;
  SELECT CASE WHEN (SELECT COALESCE(SUM(bytes),0) FROM shares)+NEW.bytes>5000000000
    THEN RAISE(ABORT,'share_site_quota') END;
END;
CREATE TRIGGER IF NOT EXISTS share_update_quota BEFORE UPDATE OF bytes ON shares BEGIN
  SELECT CASE WHEN (SELECT COALESCE(SUM(bytes),0) FROM shares WHERE source_hash=OLD.source_hash AND expires_at>NEW.updated_at)-OLD.bytes+NEW.bytes>52428800
    THEN RAISE(ABORT,'share_source_quota') END;
  SELECT CASE WHEN (SELECT COALESCE(SUM(bytes),0) FROM shares)-OLD.bytes+NEW.bytes>5000000000
    THEN RAISE(ABORT,'share_site_quota') END;
END;
CREATE TRIGGER IF NOT EXISTS share_rate_limit BEFORE UPDATE OF total ON share_rates
WHEN NEW.total>CASE NEW.action WHEN 'report' THEN 10 ELSE 60 END
BEGIN SELECT RAISE(ABORT,'share_frequency'); END;

CREATE TRIGGER IF NOT EXISTS share_report_added AFTER INSERT ON share_reports BEGIN
  UPDATE shares SET reports=reports+1, updated_at=NEW.created_at,
    status=CASE WHEN status='active' AND reports+1>=3 THEN 'reported' ELSE status END
  WHERE id=NEW.share_id;
END;
