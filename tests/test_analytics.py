"""End-to-end owner analytics against an isolated collaborative room."""
import json
from contextlib import closing
from datetime import datetime, timezone
from unittest.mock import patch

from backend.analytics import peak_concurrent, period
from backend.analytics_issues import concurrency_series
from backend.server import connect_db, destroy_expired_rooms
from tests.test_free_room import FreeRoomTests, HostRoomTests


class AnalyticsTests(HostRoomTests):
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
