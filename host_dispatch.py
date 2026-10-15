"""将话题轮次变化投递到已有 Codex 主持会话，不调用模型服务 API。"""

import argparse
import hashlib
import json
import logging
import os
import re
import shutil
import sqlite3
import subprocess
import time
import uuid
from contextlib import closing
from pathlib import Path
from urllib.error import URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
DEFAULT_INTERVAL_SECONDS = 12
MIN_INTERVAL_SECONDS = 1
MAX_INTERVAL_SECONDS = 3600
HTTP_TIMEOUT_SECONDS = 15
QUEUE_TIMEOUT_SECONDS = 30
STOP_CHECK_SECONDS = 1
DEFAULT_STATE_FILE = ROOT / "data" / "host-dispatch.sqlite3"
HOST_NAME = "Codex"
USER_AGENT = "AI-CoDiscuss-Host/1.0"
LOG = logging.getLogger(__name__)


class DeliveryUncertain(RuntimeError):
    """A queue invocation may have been accepted and must not be retried blindly."""


def parse_options(arguments=None):
    """Parse a local room-to-session binding and validate its identifiers."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True, help="留言板站点地址")
    parser.add_argument("--room", required=True, help="房间 ID，主持人必须为 Codex")
    parser.add_argument("--thread", required=True, help="已有 Codex 主持会话 UUID")
    parser.add_argument("--codex", default="codex", help="支持 queue 的 Codex 可执行文件")
    parser.add_argument("--remote", help="可选：该会话所属 app-server 地址")
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE_FILE, help="本地投递记录 SQLite")
    parser.add_argument("--interval", type=float, default=DEFAULT_INTERVAL_SECONDS)
    parser.add_argument("--once", action="store_true", help="只检查一次")
    parser.add_argument("--dry-run", action="store_true", help="只预览一次通知，不投递、不写记录")
    parser.add_argument("--retry-event", help="确认未入队且旧进程已停止后，重试指定不确定事件")
    parser.add_argument("--stop-file", type=Path, help="专属停止信号文件；出现时退出本次监控")
    parser.add_argument("--events", choices=("answers", "all"), default="answers",
                        help="默认仅回答留档唤醒；all 兼容启动、待通知与取消事件")
    options = parser.parse_args(arguments)
    options.url = options.url.rstrip("/")
    address = urlsplit(options.url)
    if address.scheme not in {"http", "https"} or not address.netloc or address.query or address.fragment:
        parser.error("--url 必须是没有查询参数或片段的 HTTP(S) 站点地址")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", options.room):
        parser.error("--room 必须是房间 ID")
    try:
        options.thread = str(uuid.UUID(options.thread))
    except ValueError:
        parser.error("--thread 必须为已有会话 UUID，不接受名称匹配")
    if not MIN_INTERVAL_SECONDS <= options.interval <= MAX_INTERVAL_SECONDS:
        parser.error(f"--interval 需在 {MIN_INTERVAL_SECONDS}–{MAX_INTERVAL_SECONDS} 秒之间")
    if options.retry_event and (not options.once or options.dry_run):
        parser.error("--retry-event 必须配合 --once，不能配合 --dry-run")
    return options


def check_codex(executable):
    """Resolve a native executable and verify that it supports the queue command."""
    path = shutil.which(executable)
    if not path:
        raise ValueError("未找到 Codex；请用 --codex 指定支持 queue 的可执行文件")
    if os.name == "nt" and Path(path).suffix.lower() != ".exe":
        raise ValueError("Windows 请用 --codex 指定原生 codex.exe，避免通过 CMD/PowerShell 转义通知")
    result = subprocess.run([path, "help", "queue"], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=QUEUE_TIMEOUT_SECONDS)
    if result.returncode or "--thread" not in result.stdout or "--message" not in result.stdout:
        raise ValueError("此 Codex 不支持 queue；请用 --codex 指定兼容版本")
    return path


def read_room(options):
    """Read the current room without changing its messages or notification status."""
    request = Request(f"{options.url}/api/rooms/{options.room}",
                      headers={"Cache-Control": "no-cache", "User-Agent": USER_AGENT})
    with urlopen(request, timeout=HTTP_TIMEOUT_SECONDS) as response:
        room = json.load(response)
    if room.get("id") != options.room:
        raise ValueError("返回的房间 ID 与绑定不一致")
    if room.get("host") != HOST_NAME or room.get("experts", {}).get(HOST_NAME) != "cli":
        raise ValueError("绑定房间必须将 Codex 配置为本地 CLI 主持人；不会自动修改话题角色")
    return room


def build_event(room, base_url, events="answers"):
    """Build one actionable event containing a question and reading links only."""
    if room["phase"] in {"paused", "concluded"}:
        return None
    turn = room.get("current_turn")
    if events == "answers" and (not turn or turn["status"] != "answered" or turn["expert"] == HOST_NAME):
        return None
    if not turn:
        event_id, question = "start", "请按需读取话题并开始主持，确定下一步发言安排。"
    elif turn["status"] == "pending":
        event_id = f"turn-{turn['id']}-pending"
        question = f"安排 #{turn['id']} 待通知 {turn['expert']}。待回应问题：{turn['question']}"
    elif turn["status"] == "answered":
        event_id = f"turn-{turn['id']}-answered-{turn['answer_id']}"
        question = f"安排 #{turn['id']} 的回答 #{turn['answer_id']} 已留档，请按需读取并决定下一步。"
    elif turn["status"] == "cancelled":
        event_id, question = f"turn-{turn['id']}-cancelled", f"安排 #{turn['id']} 已取消，请确定下一步。"
    else:
        return None
    entry = f"{base_url}/r/{room['id']}"
    lines = [f"请以 {HOST_NAME} 身份继续主持话题。事件：{event_id}", question,
             f"话题入口：{entry}?{urlencode({'mode': 'cli', 'participant': HOST_NAME})}"]
    if turn:
        lines.append(f"发言安排：{entry}/turns/{turn['id']}")
    lines.extend(["先核对话题阶段和当前安排编号；已暂停、已收束、已处理或过期事件只忽略，不能据此恢复讨论。",
                  "资料按需读取；已启用后台参与的专家等待其自行读取，不重复通知。仅实际联系成功后确认通知。"])
    return event_id, "\n".join(lines)


def binding_key(options):
    """Identify a site, room, session and server independently of CLI upgrades."""
    binding = [options.url, options.room, options.thread, options.remote]
    return hashlib.sha256(json.dumps(binding).encode()).hexdigest()


def open_store(path):
    """Open durable local delivery records shared by dispatcher processes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=HTTP_TIMEOUT_SECONDS, isolation_level=None)
    connection.execute("""CREATE TABLE IF NOT EXISTS deliveries (
        binding TEXT NOT NULL, event_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, error TEXT NOT NULL DEFAULT '',
        PRIMARY KEY(binding,event_id))""")
    return connection


def claim_event(connection, binding, event_id):
    """Persist uncertainty before sending so a crash cannot cause automatic replay."""
    inserted = connection.execute("""INSERT OR IGNORE INTO deliveries(binding,event_id,status)
        VALUES (?,?,'uncertain')""", (binding, event_id)).rowcount
    if inserted:
        return True
    status = connection.execute("SELECT status FROM deliveries WHERE binding=? AND event_id=?",
                                (binding, event_id)).fetchone()[0]
    if status == "uncertain":
        raise DeliveryUncertain(f"事件 {event_id} 正在投递或上次结果不确定；请核对会话，禁止自动重投")
    return False


def retry_event(connection, binding, event_id):
    """Explicitly release only one uncertain event after the operator has checked it."""
    deleted = connection.execute("DELETE FROM deliveries WHERE binding=? AND event_id=? AND status='uncertain'",
                                 (binding, event_id)).rowcount
    if not deleted:
        raise ValueError("指定事件没有待核对记录；不会重投已成功入队的事件")


def queue_message(options, message):
    """Pass the entire Unicode notice as one native argument, without a shell."""
    command = [options.codex, "queue", "--thread", options.thread, "--message", message]
    if options.remote:
        command.extend(["--remote", options.remote])
    result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8",
                            errors="replace", timeout=QUEUE_TIMEOUT_SECONDS)
    if result.returncode:
        raise DeliveryUncertain(f"codex queue 退出码 {result.returncode}：{result.stderr.strip()}")


def deliver_event(options, connection, event):
    """Queue an unclaimed event once and record acceptance separately from execution."""
    event_id, message = event
    binding = binding_key(options)
    if not claim_event(connection, binding, event_id):
        return False
    try:
        queue_message(options, message)
    except (OSError, subprocess.TimeoutExpired, DeliveryUncertain) as error:
        connection.execute("UPDATE deliveries SET error=? WHERE binding=? AND event_id=?",
                           (str(error), binding, event_id))
        raise DeliveryUncertain(f"事件 {event_id} 结果不确定，已停止自动重试：{error}") from error
    connection.execute("UPDATE deliveries SET status='queued',error='' WHERE binding=? AND event_id=?",
                       (binding, event_id))
    LOG.info("事件 %s 已提交到会话 %s 的队列；尚未确认执行", event_id, options.thread)
    return True


def dispatch_once(options, connection):
    """Read one snapshot, dispatch if actionable, and stop on a concluded topic."""
    if stop_requested(options):
        return "stopped"
    room = read_room(options)
    if stop_requested(options):
        return "stopped"
    if room["phase"] in {"paused", "concluded"}:
        LOG.info("话题阶段为 %s，停止调度", room["phase"])
        return room["phase"]
    event = build_event(room, options.url, options.events)
    if not event:
        if options.retry_event:
            raise ValueError("当前没有可重试事件；请核对最新轮次")
        return "waiting"
    if options.dry_run:
        LOG.info("预览（没有投递）：\n%s", event[1])
        return "preview"
    if options.retry_event:
        if options.retry_event != event[0]:
            raise ValueError("重试事件与当前轮次不符；不会发送过期通知")
        retry_event(connection, binding_key(options), event[0])
    return "queued" if deliver_event(options, connection, event) else "unchanged"


def stop_requested(options):
    """Check only the stop signal allocated to this specific monitor process."""
    return options.stop_file is not None and options.stop_file.exists()


def wait_for_poll(options):
    """Wait between HTTP reads while allowing prompt cooperative shutdown."""
    deadline = time.monotonic() + options.interval
    while not stop_requested(options):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        time.sleep(min(STOP_CHECK_SECONDS, remaining))


def watch_room(options, connection):
    """Poll HTTP state; network errors never queue a message or consume an event."""
    LOG.info("检查房间 %s；间隔 %s 秒；目标会话 %s", options.room, options.interval, options.thread)
    while True:
        try:
            outcome = dispatch_once(options, connection)
        except (URLError, TimeoutError) as error:
            if options.once:
                raise
            LOG.warning("读取话题失败，本次未投递：%s", error)
            outcome = "offline"
        if options.once or outcome in {"paused", "concluded", "stopped"}:
            return
        wait_for_poll(options)


def main(arguments=None):
    """Run the local dispatcher, returning failure without silently replaying notices."""
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    options = parse_options(arguments)
    try:
        if options.dry_run:
            dispatch_once(options, None)
            return 0
        options.codex = check_codex(options.codex)
        with closing(open_store(options.state)) as connection:
            watch_room(options, connection)
        return 0
    except KeyboardInterrupt:
        LOG.info("调度已停止")
        return 0
    except (ValueError, OSError, RuntimeError, sqlite3.Error, subprocess.SubprocessError) as error:
        LOG.error("%s", error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
