"""End-to-end owner analytics against an isolated collaborative room."""
import json
import uuid
from contextlib import closing
from datetime import datetime, timezone
from time import time
from unittest.mock import patch

from backend.analytics import peak_concurrent, period
from backend.analytics_issues import concurrency_series
from backend.server import connect_db, destroy_expired_rooms
from tests.test_free_room import FreeRoomTests, HostRoomTests


class AnalyticsTests(HostRoomTests):
    def host_reply(self, **extra):
        """Answer the host's pending work and return the message ID."""
        execution = self.reserve_for("Claude")[1]["id"]
        status, result = self.answer(execution, **extra)
        self.assertEqual(status, 201, result)
        return result["message"]["id"]

    def report(self, query=""):
        self.server.local_site = True
        try:
            status, result = self.request("/api/analytics?tz=UTC" + query)
            self.assertEqual(status, 200, result)
            return result
        finally:
            self.server.local_site = False

    def test_scope_and_group(self):
        ids = ["Claude", "Codex", "Antigravity"]
        first = FreeRoomTests.say(self, "大家回应", to=ids, order="auto")[1]["message"]["id"]
        path = f"{self.path}/recommendations/{first}"
        revision = self.request(path, token=self.owner)[1]["revision"]
        self.assertEqual(self.request(path, {"action": "all", "revision": revision}, self.owner)[0], 200)
        self.work("Codex")
        report = self.report()
        self.assertEqual((report["overview"]["initiated"], report["overview"]["answered"]), (1, 1))
        self.assertEqual(report["overview"]["ended"], 0)
        self.assertEqual(self.request("/api/analytics")[0], 403)
        self.server.local_site = True
        self.assertEqual(self.request("/api/analytics", token=self.tokens["Codex"])[0], 403)

    def metric_message(self, db, room, date, source):
        """Seed only the persisted message identity and time used by the report."""
        return db.execute("""INSERT INTO messages(room_id,author,text,source,submission_id,created_at)
            VALUES(?,'系统','',?,?,?)""", (room, source, uuid.uuid4().hex, date)).lastrowid

    def seed_moss_routes(self, db, stamp, before):
        """Build retained records for new rooms, historical project sends, one rework and its unreported result."""
        for room in ("steward", "task", "project", "owner-task"):
            db.execute("INSERT INTO rooms(id,title,goal,created_at) VALUES(?,?,'',?)", (room, room, before if room == "steward" else stamp))
            if room != "steward":
                link = self.metric_message(db, room, stamp, "room_link")
                db.execute("INSERT INTO room_links VALUES(?,?,'steward','parent','Codex')", (link, room))
        db.execute("UPDATE room_directory SET system_kind='steward' WHERE room_id='steward'")
        db.execute("INSERT INTO moss_task_rooms VALUES('task'),('owner-task')")
        existing = self.room["id"]
        db.execute("UPDATE rooms SET created_at=? WHERE id=?", (before, existing))
        for target, expect, date in ((existing, "reply", before), (existing, "reply", stamp), (existing, "none", stamp),
                                     ("project", "reply", stamp), ("project", "reply", stamp)):
            incoming = self.metric_message(db, target, date, "user")
            db.execute("INSERT INTO message_relays(message_id,source_room_id,expect,host) VALUES(?,'steward',?,'Codex')", (incoming, expect))
            sent = self.metric_message(db, "steward", date, "room_relay_sent")
            db.execute("""INSERT INTO room_relay_sends(message_id,room_id,target_room_id,target_message_id,host)
                VALUES(?,'steward',?,?,'Codex')""", (sent, target, incoming))
            if target == "project":
                db.execute("INSERT INTO moss_delegations(message_id) VALUES(?)", (sent,))
        original, rework = [row[0] for row in db.execute("SELECT message_id FROM moss_delegations ORDER BY message_id")]
        db.execute("INSERT INTO moss_reworks VALUES(?,?)", (rework, original))
        db.execute("UPDATE moss_delegations SET state='unreported',updated_at=? WHERE message_id=?", (stamp, rework))

    def seed_moss_runs_and_archives(self, db, start):
        """Preserve exact run samples and accepted archive/restore actions including retries and owner actions."""
        member = db.execute("""INSERT INTO room_members(room_id,name,adapter,token_hash,role,created_at)
            VALUES('steward','Codex','codex_cli','hash','host','2026-03-07T00:00:00Z')""").lastrowid
        for offset, duration in ((-1, 50), (0, 10), (1, 30), (2, 100), (3, None), (23 * 3600, 60)):
            db.execute("""INSERT INTO member_executions(room_id,member_id,client_id,status,created_at,finished_at)
                VALUES('steward',?,?,?,?,?)""", (member, str(offset), "completed" if duration else "dispatched", start + offset,
                                                  start + offset + duration if duration else 0))
        actions = (("task", "archive", "member:Codex"), ("task", "archive", "member:Codex"),
                   ("task", "restore", "owner"), ("task", "archive", "member:Codex"),
                   ("owner-task", "archive", "owner"), ("project", "archive", "member:Codex"))
        for offset, (room, path, actor) in enumerate(actions):
            db.execute("INSERT INTO room_events(room_id,at,kind,data) VALUES(?,?,'api.write',?)",
                       (room, start * 1000 + offset, json.dumps({"path": "/" + path, "actor": actor, "status": 200})))

    def test_moss_metrics_share_analytics_access_and_filter_events_by_local_dates(self):
        date, before = "2026-03-08T08:00:00Z", "2026-03-08T07:59:59Z"
        start = int(datetime.fromisoformat(date.replace("Z", "+00:00")).timestamp())
        with closing(connect_db(self.database)) as db, db:
            self.seed_moss_routes(db, date, before)
            self.seed_moss_runs_and_archives(db, start)
        query = "/api/analytics/moss?from=2026-03-08&to=2026-03-09&tz=America%2FLos_Angeles"
        self.assertEqual(self.request(query)[0], 403)
        self.server.local_site = True
        self.assertEqual(self.request(query, token=self.tokens["Codex"])[0], 403)
        status, report = self.request(query)
        self.assertEqual(status, 200, report)
        self.assertEqual({key: report[key] for key in ("task_rooms", "project_rooms", "delegations", "reworks", "unreported", "reclaimed")},
                         {"task_rooms": 2, "project_rooms": 1, "delegations": 1, "reworks": 1, "unreported": 1, "reclaimed": 2})
        self.assertEqual(report["executions"], {"count": 4, "samples": 3, "p50": 30, "p90": 86, "approximate": False})
        self.assertEqual(self.request("/api/analytics/moss?range=wrong")[0], 400)
        status, total = self.request("/api/analytics/moss?range=all&tz=UTC")
        self.assertEqual(status, 200, total)
        self.assertEqual((total["delegations"], total["executions"]["count"]), (2, 6))

    def test_merged_late_answer_stop_and_rewind(self):
        first = FreeRoomTests.say(self, "一", to=["Codex"])[1]["message"]["id"]
        FreeRoomTests.say(self, "二", to=["Codex"])
        execution = self.reserve_for("Codex")[1]["id"]
        self.request(f"{self.path}/executions/{execution}", {"action": "fail", "reason": "timeout"}, self.owner)
        payload = {"author": "Codex", "text": "答复", "source": "cli", "submission_id": "late-report-test",
                   "execution_id": execution}
        self.assertEqual(self.request(f"{self.path}/messages", payload, self.tokens["Codex"])[0], 201)
        FreeRoomTests.say(self, "三", to=["Codex"])
        self.reserve_for("Codex")
        self.request(f"{self.path}/stop", {}, self.owner)
        plan = self.request(f"{self.path}/rewind?message_id={first}", token=self.owner)[1]
        self.request(f"{self.path}/rewind", {"message_id": first, "revision": plan["revision"]}, self.owner)
        report = self.report()
        codex = next(m for m in report["members"] if m["member"] == "Codex")
        self.assertEqual((codex["accepted"], codex["executions"], codex["completed"], codex["revived"], codex["cancelled"]),
                         (3, 2, 1, 1, 1))
        self.assertEqual(report["time"]["execution"]["samples"], 2)
        self.assertEqual(report["time"]["corrections"], {"stops": 1, "rewinds": 1, "withdrawals": 0, "affected_requests": 4})
        self.assertEqual(report["overview"]["unassisted"], 0)

    def test_stopping_pending_group_counts_as_one_intervention(self):
        FreeRoomTests.say(self, "请两位回应", to=["Codex", "Antigravity"])
        self.assertEqual(self.request(f"{self.path}/stop", {}, self.owner)[0], 200)
        report = self.report()
        self.assertEqual((report["overview"]["ended"], report["overview"]["unassisted"]), (1, 0))
        self.assertEqual(report["time"]["corrections"]["stops"], 1)

    def test_deleted_room_sealed_once_and_scope_cache_isolated(self):
        self.say("私有标题不应出现在统计里")
        self.work("Claude")
        before = self.report()
        self.assertEqual(self.request(self.path + "/delete", {"actor": "用户"}, self.owner)[0], 200)
        all_rooms = self.report()
        self.assertEqual(all_rooms["overview"]["initiated"], before["overview"]["initiated"])
        self.assertEqual(all_rooms["overview"]["delivery"]["samples"], before["overview"]["delivery"]["samples"])
        self.assertTrue(all_rooms["overview"]["delivery"]["approximate"])
        self.assertEqual(all_rooms["scope"]["sealed_rooms"], 1)
        self.assertEqual(all_rooms["members"], [])
        self.assertEqual(all_rooms["models"], [])
        self.assertEqual(all_rooms["overview"]["daily"], before["overview"]["daily"])
        self.assertEqual(sum(d["initiated"] for d in all_rooms["overview"]["daily"]), all_rooms["overview"]["initiated"])
        self.assertEqual(self.report("&scope=current")["overview"]["initiated"], 0)
        self.server.local_site = True
        status, result = self.request(self.path + "/destruction", {"action": "retry"})
        self.assertEqual(status, 200, result)
        self.assertEqual(self.report("&scope=all")["overview"], all_rooms["overview"])
        with closing(connect_db(self.database)) as db:
            rows = list(db.execute("SELECT * FROM analytics_sealed_days"))
            self.assertTrue(rows)
            for row in rows:
                self.assertNotIn(self.room["id"], str(tuple(row)))
                self.assertNotIn("私有标题", str(tuple(row)))

    def test_auto_destroy_uses_same_archive_transaction(self):
        self.say("一")
        self.work("Claude")
        with patch("backend.server.expired_rooms", return_value=[self.room["id"]]):
            destroy_expired_rooms(self.server)
        self.assertEqual(self.report()["overview"]["answered"], 1)
        self.assertEqual(self.report("&scope=current")["overview"]["answered"], 0)

    def test_models_pool_raw_samples_and_daily_uses_local_midnight(self):
        _, other = self.request("/api/rooms", {"title": "Second", "mode": "free", "members": [{"name": "Claude",
                                "adapter": "claude", "token": self.member}], "submission_id": "analytics-second"}, self.owner)
        first = self.room["id"]
        start = int(datetime.fromisoformat("2026-03-08T07:59:58+00:00").timestamp())
        samples = [(first, -10, 2, "M"), (first, 0, 4, "M"), (other["id"], 23*3600, 100, "M"),
                   (other["id"], 1000, 3, "")]
        with closing(connect_db(self.database)) as db, db:
            for room, offset, duration, model in samples:
                db.execute("""INSERT INTO member_executions(room_id,member_id,client_id,status,created_at,finished_at,model,effort)
                    SELECT room_id,id,?,'completed',?,?,?,'high' FROM room_members WHERE room_id=? AND name='Claude'""",
                           (str(offset), start+offset, start+offset+duration, model, room))
            # Two of the "M" runs ran under workflow "wf"; the first also reported an unbound delivery before it.
            ids = [row[0] for row in db.execute("SELECT id FROM member_executions WHERE model='M' ORDER BY id LIMIT 2")]
            bindings = [[None, {"id": "wf", "card": "writer", "sub_workflow": None}], [{"id": "wf", "card": "editor", "sub_workflow": "polish"}]]
            for execution_id, items in zip(ids, bindings):
                db.execute("INSERT INTO execution_diagnostics(execution_id,details) VALUES (?,?)",
                           (execution_id, json.dumps({"workflow_bindings": items})))
            # Three runs the owner stopped make an “interrupted” issue whose runs point back to their room.
            for index in range(3):
                db.execute("""INSERT INTO member_executions(room_id,member_id,client_id,status,result,created_at,finished_at,model,effort)
                    SELECT room_id,id,?,'cancelled','用户打断',?,?,'S','low' FROM room_members WHERE room_id=? AND name='Claude'""",
                           (f"stop-{index}", start+index*60, start+index*60+5, first))
            # The same runner fault on two models is one issue grouped by its reason, naming both members.
            for index, model in enumerate(("T", "T", "U", "U")):
                db.execute("""INSERT INTO member_executions(room_id,member_id,client_id,status,result,created_at,finished_at,model,effort)
                    SELECT room_id,id,?,'failed','执行租约到期，接入程序未续租',?,?,?,'' FROM room_members WHERE room_id=? AND name='Claude'""",
                           (f"lease-{index}", start+500+index, start+500+index, model, first))
        report = self.report("&from=2026-03-07&to=2026-03-11&tz=America%2FLos_Angeles")
        lease = [item for item in report["issues"] if item["rule"] == "not_finished" and "续租" in item["params"]["reason"]]
        self.assertEqual(len(lease), 1)
        self.assertEqual((lease[0]["count"], lease[0]["total"], lease[0]["level"]), (4, 4, "high"))
        self.assertEqual(sorted(member["model"] for member in lease[0]["members"]), ["T", "U"])
        self.assertEqual(sum(report["time"]["concurrency"]["unfinished"]), 4)
        self.assertIn("peak_members", report["previous"])
        stopped = [item for item in report["issues"] if item["rule"] == "interrupted"]
        self.assertEqual(len(stopped), 1)
        self.assertEqual((stopped[0]["count"], stopped[0]["total"], stopped[0]["params"]["model"]), (3, 3, "S"))
        self.assertEqual({run["room_id"] for run in stopped[0]["runs"]}, {first})
        self.assertTrue(all(run["title"] for run in stopped[0]["runs"]))
        self.assertEqual(max(report["time"]["concurrency"]["points"]), report["time"]["peak"]["members"])
        workflow, = report["workflows"]
        self.assertEqual((workflow["id"], workflow["executions"], workflow["completed"], workflow["rooms"]), ("wf", 2, 2, 1))
        self.assertEqual((workflow["cards"], workflow["sub_workflows"]), ({"writer": 1, "editor": 1}, {"polish": 1}))
        models = {m["model"]: m for m in report["models"]}
        self.assertEqual(models["M"]["duration"], {"samples": 3, "p50": 4, "p90": 80.8, "approximate": False})
        self.assertEqual(models["M"]["completed"], 3)
        self.assertEqual(models[""]["executions"], 1)
        self.assertNotIn("room_id", models["M"])
        days = report["overview"]["daily"]
        self.assertEqual([d["date"] for d in days], ["2026-03-07","2026-03-08","2026-03-09","2026-03-10"])
        self.assertEqual([d["execution_seconds"] for d in days], [6, 20, 98, 0])  # +3 stopped 5 s runs, the first split at midnight
        self.assertEqual(sum(d["execution_seconds"] for d in days), report["time"]["execution_seconds"])
        # Per-room rows break each folder down: their totals match the folder rows exactly.
        rooms, folders = report["time"]["rooms"], report["time"]["folders"]
        for key in ("initiated", "execution_seconds"):
            self.assertEqual(sum(r[key] for r in rooms), sum(f[key] for f in folders))
        self.assertTrue(all(r["title"] and "folder_id" in r for r in rooms))

    def test_dispatch_quality_groups_chain_records_by_host_version(self):
        """The dispatch section reads the shared chain records: a withdrawn dispatch is voided under its host version."""
        FreeRoomTests.say(self, "安排工作")
        host = self.reserve_for("Claude")[1]["id"]
        version = {"package_version": "1.2.3", "prompt_hash": "0123456789ab", "skill_hash": "0123456789abcdef"}
        self.request(f"{self.path}/executions/{host}",
                     {"action": "model", "model": "opus", "effort": "high", "host_version": version}, self.owner)
        dispatch = self.answer(host, "请 Codex 处理", to=["Codex"])[1]["message"]["id"]
        self.assertEqual(self.request(f"{self.path}/dispatches/{dispatch}/withdraw", {}, self.owner)[0], 200)
        section = self.report("&dispatch=1")["dispatch_quality"]
        group, = section["groups"]
        self.assertEqual((group["kind"], group["model"], group["package_version"], group["prompt_hash"]),
                         ("known", "opus", "1.2.3", "0123456789ab"))
        self.assertEqual(group["skill_hash"], "0123456789abcdef")
        self.assertEqual((section["ended"], group["chains"], group["dispatch_messages"], group["voided"]), (1, 1, 1, 1))
        self.assertEqual(group["voided_examples"], [{"room_id": self.room["id"], "message_id": dispatch}])

    def test_live_view_lists_running_and_failed_work(self):
        """The live view shows who runs now and a failed request as waiting for the owner, minute by minute."""
        FreeRoomTests.say(self, "一", to=["Codex"])
        FreeRoomTests.say(self, "二", to=["Antigravity"])
        running = self.reserve_for("Codex")[1]["id"]
        failed = self.reserve_for("Antigravity")[1]["id"]
        self.request(f"{self.path}/executions/{failed}", {"action": "fail", "reason": "timeout"}, self.owner)
        live = self.report("&range=live")["live"]
        self.assertEqual([(item["execution_id"], item["member"]) for item in live["running"]], [(running, "Codex")])
        self.assertEqual(live["waiting"], [])  # a failed run is not a wait (#15793)
        self.assertEqual(len(live["timeline"]["rooms"]), 60)
        room, = live["rooms"]
        self.assertEqual((room["room_id"], room["running"], room["runs"], room["errors"], room["members"]),
                         (self.room["id"], 1, 2, 1, 2))
        self.assertEqual((live["errors"], len(live["timeline"]["points"]), live["timeline"]["step"]), (1, 60, 60))

    def test_marked_wait_live_and_history_with_delivery_receipt(self):
        """Live lists two members waiting; history retains starts, owner replies and scoped delivery evidence."""
        self.say("请看看")
        first_message = self.host_reply(text="已比对两个方案\n请选一个方案", summary="等你选方案", awaiting_user=True)
        status, second = self.answer(None, "请确认范围", token=self.codex, author="Codex",
                                     proactive=True, awaiting_user=True)
        self.assertEqual(status, 201, second)
        messages = [first_message, second["message"]["id"]]
        live = self.report("&range=live")["live"]
        self.assertEqual({(item["kind"], item["member"], item["message_id"], item["count"]) for item in live["waiting"]},
                         {("awaiting", "Claude", messages[0], 1), ("awaiting", "Codex", messages[1], 1)})
        first_at = int(time()) - 350
        with closing(connect_db(self.database)) as db, db:
            wait_id = db.execute("SELECT id FROM room_waits WHERE message_id=?", (messages[0],)).fetchone()[0]
            other_wait_id = db.execute("SELECT id FROM room_waits WHERE message_id=?", (messages[1],)).fetchone()[0]
            db.execute("UPDATE room_waits SET created_at=? WHERE id=?", (first_at, wait_id))
        notify = self.database.parent / "notify"
        notify.mkdir()
        room = self.room["id"]
        notice = {"key": f"{self.base}/{room}/wait:{wait_id}", "room": room, "site": self.base,
                  "sent_at": (first_at + 181) * 1000,
                  "deliveries": {"telegram": ["test-message"]}}
        mismatched = {**notice, "key": f"{self.base}/{room}/wait:{other_wait_id}", "site": "https://elsewhere.test",
                      "sent_at": int(time()) * 1000}
        (notify / "notices.json").write_text(json.dumps({"notices": [notice, mismatched]}), encoding="utf-8")
        with patch.dict("os.environ", {"DISCUSS_SERVICE_HOME": str(self.database.parent)}):
            open_issue, = [item for item in self.report()["issues"] if item["rule"] == "stall"]
            self.server.analytics_cache.clear()
            reply = self.say("确定用第一个\n接着做")[1]["message"]["id"]
            issue, = [item for item in self.report()["issues"] if item["rule"] == "stall"]
        self.assertFalse(self.report("&range=live")["live"]["waiting"])
        self.assertEqual((open_issue["events"][0]["end"], open_issue["events"][0]["reply_message_id"]), (0, 0))
        self.assertEqual((issue["params"], issue["count"], issue["suspected_count"]), ({}, 2, 0))
        first, second = issue["events"]
        self.assertEqual((first["start"], first["seconds"], first["message_id"], first["reply_message_id"]),
                         (first_at, first["end"] - first_at, messages[0], reply))
        self.assertEqual((first["excerpt"], first["reply"], first["notified"], first["suspected"]),
                         ("等你选方案", "确定用第一个", True, False))
        self.assertEqual(first["end_reason"], "user")
        self.assertFalse(second["notified"])

    def test_non_user_wait_end_has_no_reply(self):
        """An unmarked answer ends the wait, even if a new wait opens within the same second."""
        self.say("请看看")
        first_message = self.host_reply(text="请选一个方案", awaiting_user=True)
        status, result = self.answer(None, "已有信息，接着做", proactive=True)
        self.assertEqual(status, 201, result)
        self.assertFalse(self.report("&range=live")["live"]["waiting"])
        issue, = [item for item in self.report()["issues"] if item["rule"] == "stall"]
        event, = issue["events"]
        self.assertEqual((event["message_id"], event["end_reason"], event["reply_message_id"], event["reply"]),
                         (first_message, "superseded", 0, ""))
        self.assertGreater(event["end"], 0)
        status, next_wait = self.answer(None, "现在有另一个问题", proactive=True, awaiting_user=True)
        self.assertEqual(status, 201, next_wait)
        with closing(connect_db(self.database)) as db, db:
            db.execute("UPDATE room_waits SET created_at=? WHERE message_id=?",
                       (event["end"], next_wait["message"]["id"]))
        self.server.analytics_cache.clear()
        issue, = [item for item in self.report()["issues"] if item["rule"] == "stall"]
        self.assertEqual(issue["count"], 2)

    def test_replacement_wait_uses_first_start_and_final_reply(self):
        """An immediate replacement does not double-count a wait or move it to the next day."""
        self.say("请看看")
        first = self.host_reply(text="比较完成\n\n选方案？\n可选一或二\n不进摘录", awaiting_user=True)
        status, replacement = self.answer(None, "换个问法，选第几个？", proactive=True, awaiting_user=True)
        self.assertEqual(status, 201, replacement)
        second = replacement["message"]["id"]
        today = int(time()) // 86400 * 86400
        with closing(connect_db(self.database)) as db, db:
            db.execute("UPDATE room_waits SET created_at=?,ended_at=? WHERE message_id=?", (today - 600, today, first))
            db.execute("UPDATE room_waits SET created_at=? WHERE message_id=?", (today, second))
        self.assertFalse(any(i["rule"] == "stall" for i in self.report("&range=today")["issues"]))
        open_issue, = [i for i in self.report()["issues"] if i["rule"] == "stall"]
        self.assertEqual((open_issue["count"], open_issue["events"][0]["end"]), (1, 0))
        self.server.analytics_cache.clear()
        reply = self.say("第二个")[1]["message"]["id"]
        issue, = [i for i in self.report()["issues"] if i["rule"] == "stall"]
        event, = issue["events"]
        self.assertEqual((issue["count"], event["start"], event["message_id"], event["end_reason"]),
                         (1, today - 600, first, "user"))
        self.assertEqual((event["excerpt"], event["reply_message_id"], event["reply"]),
                         ("比较完成 选方案？ 可选一或二", reply, "第二个"))

    def test_historical_wait_requires_a_quiet_gap_and_redispatch(self):
        """A host answer and prompt redispatch suggest a stall only if no request was in flight."""
        owner = self.say("请安排")[1]["message"]["id"]
        answer = self.host_reply(text="请你确认？")
        reply = self.say("确认")[1]["message"]["id"]
        dispatch = self.host_reply(to=["Codex"])
        start = int(time()) - 3600
        with closing(connect_db(self.database)) as db, db:
            for message, stamp in ((owner, start - 60), (answer, start), (reply, start + 1900), (dispatch, start + 1910)):
                created = datetime.fromtimestamp(stamp, timezone.utc).isoformat()
                db.execute("UPDATE messages SET created_at=? WHERE id=?", (created, message))
                db.execute("UPDATE member_requests SET created_at=? WHERE message_id=?", (stamp, message))
        issue, = [item for item in self.report()["issues"] if item["rule"] == "stall"]
        self.assertEqual((issue["count"], issue["suspected_count"]), (0, 1))
        event, = issue["events"]
        self.assertEqual((event["message_id"], event["reply_message_id"], event["seconds"], event["suspected"], event["notified"]),
                         (answer, reply, 1900, True, False))
        with closing(connect_db(self.database)) as db, db:
            db.execute("""INSERT INTO member_requests(room_id,member_id,message_id,created_at)
                        VALUES(?,?,?,?)""", (self.room["id"], self.member_id("Antigravity"), owner, start - 60))
        self.server.analytics_cache.clear()
        self.assertFalse(any(item["rule"] == "stall" for item in self.report()["issues"]))

    def test_suspected_wait_requires_question_punctuation_and_at_most_a_day(self):
        """An overnight gap is bounded and a statement with only a URL query does not count."""
        owner = self.say("请安排")[1]["message"]["id"]
        answer = self.host_reply(text="Which option?")
        reply = self.say("第一个")[1]["message"]["id"]
        dispatch = self.host_reply(to=["Codex"])
        status, result = self.answer(None, "等待你的选择", proactive=True, awaiting_user=True)
        self.assertEqual(status, 201, result)
        start = int(time()) - 48 * 3600
        cases = (("Which option?", 86400, 1), ("Which option?", 86401, 0),
                 ("下一步见 https://example.org/?step=2", 1900, 0))
        for text, gap, expected in cases:
            with self.subTest(text=text, gap=gap):
                with closing(connect_db(self.database)) as db, db:
                    for message, stamp in ((owner, start - 60), (answer, start), (reply, start + gap),
                                           (dispatch, start + gap + 10)):
                        created = datetime.fromtimestamp(stamp, timezone.utc).isoformat()
                        db.execute("UPDATE messages SET created_at=? WHERE id=?", (created, message))
                        db.execute("UPDATE member_requests SET created_at=? WHERE message_id=?", (stamp, message))
                    db.execute("UPDATE messages SET text=? WHERE id=?", (text, answer))
                self.server.analytics_cache.clear()
                issue, = [item for item in self.report()["issues"] if item["rule"] == "stall"]
                self.assertEqual((issue["count"], issue["suspected_count"]), (1, expected))
                if expected:
                    self.server.analytics_cache.clear()
                    with patch("backend.analytics_issues.RUNS_PER_ISSUE", 1):
                        limited, = [item for item in self.report()["issues"] if item["rule"] == "stall"]
                    self.assertEqual(len(limited["events"]), 1)
                    self.assertFalse(limited["events"][0]["suspected"])

    def test_dst_and_concurrency(self):
        instant = datetime(2026, 3, 8, 12, tzinfo=timezone.utc).timestamp()
        _, (_, start, end) = period({"tz": "America/Los_Angeles", "range": "week"}, instant)
        self.assertEqual(end-start, 167 * 3600)
        spans = {"one": [(10, 20), (13, 25)], "two": [(18, 20)], "three": [(25, 30)]}
        self.assertEqual(peak_concurrent(spans), (2, 18))
        # Experts are keyed by room and member: two members in one room count twice, one member's overlaps once.
        experts = {("r1", "A"): [(10, 20), (12, 15)], ("r1", "B"): [(14, 22)], ("r2", "A"): [(14, 16)]}
        self.assertEqual(peak_concurrent(experts), (3, 14))
        # The share card's timeline keeps the same peak; hourly buckets over a short window.
        series = concurrency_series(experts, 0, 7200)
        self.assertEqual(series["step"], 3600)
        self.assertEqual(series["points"], [3, 0])
