#!/usr/bin/env python3
"""AI CoDiscuss 命令行客户端：显式目标、按需读取、可重放的 HTTP 写入。"""

import argparse
import hashlib
import json
import math
import os
import re
import sys
from dataclasses import dataclass
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

VERSION = "0.2.0"
DEFAULT_TIMEOUT = 20
MAX_BODY_BYTES = 512 * 1024
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_MESSAGE_ATTACHMENTS = 10
MAX_TEXT_LENGTH = 32000
MAX_SUMMARY_LENGTH = 1000
MAX_BRIEF_LENGTH = 1600
PARTICIPANTS = ("用户", "Codex", "Claude", "Gemini", "DeepSeek", "Qwen")
PHASES = ("preparing", "initial", "discussing", "reviewing", "paused", "concluded")
KINDS = ("opinion", "moderation", "receipt")
OVERVIEW_FIELDS = ("id", "title", "goal", "host", "phase", "focus", "message_count",
                   "latest_id", "state_until", "current_turn", "queued_turns", "held_since", "floor", "runtime", "limits", "completed_rounds", "latest_receipts", "answered_turns", "duplicate", "submission_id")
BRIEF_FIELDS = ("id", "title", "goal", "host", "user_request", "background", "boundaries", "experts")
ROOM_LIST_FIELDS = ("id", "title", "goal", "message_count", "latest_id", "created_at")
GUIDANCE = {
    "initial": "先基于目标、背景和边界独立形成观点；提交前不读他人观点或主持总结。",
    "paused": "停止处理安排并停止本讨论自己的后台任务，核对实际状态；非必要不生成 receipt，正常停止无需回执。",
    "concluded": "话题已收束；停止本讨论自己的后台任务并核对实际状态；非必要不生成 receipt，正常停止无需回执。",
}
EXIT_CODES = {"0": "成功", "1": "HTTP/API 错误", "2": "参数或输入错误",
              "3": "网络失败或响应无法确认", "130": "被中断，写入结果需核对"}


class CliError(Exception):
    """Carry a stable exit code and machine-readable error details."""

    def __init__(self, message, code=2, **details):
        super().__init__(message)
        self.code = code
        self.details = details


class Parser(argparse.ArgumentParser):
    """Report parser failures through the same stderr contract as API errors."""

    def error(self, message):
        """Raise a usage error instead of printing a separate argparse format."""
        raise CliError(message, hint=f"查看 {self.prog} --help")


class NoRedirect(HTTPRedirectHandler):
    """Do not silently move a request to another service or convert POST to GET."""

    def redirect_request(self, *args, **kwargs):
        """Leave redirects as HTTP errors so the target remains explicit."""
        return None


@dataclass
class RequestPlan:
    """Describe one request without performing network or persistence work."""

    path: str
    method: str = "GET"
    body: dict | None = None
    view: str | None = None
    params: dict | None = None
    upload_file: str | None = None
    download_file: str | None = None


def positive_int(value):
    """Parse a positive page or resource identifier."""
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("必须为正整数") from error
    if number < 1:
        raise argparse.ArgumentTypeError("必须为正整数")
    return number


def room_id(value):
    """Accept an existing room identifier without allowing path components."""
    if not re.fullmatch(r"[A-Za-z0-9_-]+", value):
        raise argparse.ArgumentTypeError("房间 ID 只能包含字母、数字、下划线和连字符")
    return value


def non_negative_int(value):
    """Parse a message cursor, including zero for the start of history."""
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("必须为非负整数") from error
    if number < 0:
        raise argparse.ArgumentTypeError("必须为非负整数")
    return number


def submission_id(value):
    """Validate the server's reusable submission identifier format."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{8,100}", value):
        raise argparse.ArgumentTypeError("提交编号需为 8–100 位字母、数字、下划线或连字符")
    return value


def attachment_id(value):
    """Accept only opaque file identifiers, never local or remote paths."""
    if not re.fullmatch(r"[a-f0-9]{32}", value):
        raise argparse.ArgumentTypeError("附件 ID 需为服务端返回的 32 位小写十六进制编号")
    return value


def add_common(parser):
    """Allow common flags before or after subcommands without shared state."""
    options = {"default": argparse.SUPPRESS}
    parser.add_argument("--site", help="HTTP 服务地址；未指定时读 DISCUSS_URL", **options)
    parser.add_argument("--as", dest="actor", choices=PARTICIPANTS,
                        help="业务写入的声明操作者；不是登录认证；api 使用原始请求体", **options)
    parser.add_argument("-o", "--output", choices=("json", "text"),
                        help="默认 json；成功 stdout，错误 stderr", **options)
    parser.add_argument("--timeout", type=float, help="请求超时秒数，默认 20", **options)
    parser.add_argument("--dry-run", action="store_true", help="只预览写入请求，不联网", **options)
    parser.add_argument("--access-file", help="本房间的受限凭据 JSON；不输出其 token", **options)


def add_text(parser, name, required=False):
    """Offer mutually exclusive literal and UTF-8 file inputs for one field."""
    group = parser.add_mutually_exclusive_group(required=required)
    group.add_argument(f"--{name}", help=f"{name} 正文", default=argparse.SUPPRESS)
    group.add_argument(f"--{name}-file", help="UTF-8 文件；- 从标准输入读取",
                       default=argparse.SUPPRESS)


def add_topic(parser, create=False):
    """Expose topic fields, using a full experts map to avoid hidden merging."""
    for field in ("title", "goal", "user_request", "background", "boundaries", "focus"):
        add_text(parser, field.replace("_", "-"), required=create and field == "title")
    parser.add_argument("--host", choices=PARTICIPANTS, default=argparse.SUPPRESS,
                        help="主持人；创建时默认 --as 操作者")
    parser.add_argument("--phase", choices=PHASES, default=argparse.SUPPRESS)
    parser.add_argument("--experts-file", default=argparse.SUPPRESS,
                        help='完整参与者映射 JSON，如 {"Codex":"cli","Gemini":"cli"}；替换整个映射')
    for name in ("max-rounds", "max-minutes", "execution-minutes", "summary-minutes"):
        parser.add_argument(f"--{name}", type=non_negative_int, default=argparse.SUPPRESS)
    parser.add_argument("--on-limit", choices=("pause", "summarize"), default=argparse.SUPPRESS)


def add_leaf(subcommands, registry, name, description, needs_room=False):
    """Register one discoverable command and its common options."""
    parser = subcommands.add_parser(name.split()[-1], help=description, description=description,
                                   allow_abbrev=False)
    add_common(parser)
    parser.set_defaults(operation=name)
    if needs_room:
        parser.add_argument("room", type=room_id, help="房间 ID；始终显式指定")
    registry[name] = parser
    return parser


def room_commands(subcommands, registry):
    """Register room discovery, progressive reading, creation, and updates."""
    for action, description in (("list", "列出房间概要"), ("view", "只读目标、阶段、焦点及当前安排"),
                                ("brief", "按需读取背景、边界和专家配置"),
                                ("protocol", "按需读取当前服务的参与协议")):
        parser = add_leaf(subcommands, registry, f"room {action}", description, action != "list")
        if action == "list":
            parser.add_argument("--submission-id", type=submission_id, help="按建房提交编号精确查询")
    limits = add_leaf(subcommands, registry, "room limits", "查看上限；--check 检查并执行到限处理", True)
    limits.add_argument("--check", action="store_true")
    create = add_leaf(subcommands, registry, "room create", "创建话题；不自动启动讨论或监控")
    create.add_argument("--folder-id", help="直接在指定文件夹中创建；省略则未归类")
    add_topic(create, create=True)
    create.add_argument("--submission-id", type=submission_id, required=True,
                        help="新话题唯一编号；未知结果先查询，重试沿用编号和原始资料")
    update = add_leaf(subcommands, registry, "room update", "维护话题；省略的字段保持不变", True)
    add_topic(update)


def message_commands(subcommands, registry):
    """Register bounded search, exact reads, and attributed message writes."""
    listing = add_leaf(subcommands, registry, "message list", "按页检索原文，每页 20 条", True)
    paging = listing.add_mutually_exclusive_group()
    paging.add_argument("--page", type=positive_int, default=1)
    paging.add_argument("--after", type=non_negative_int, help="只读此消息编号之后的内容；按 next_after 续读")
    listing.add_argument("--query", help="关键词或消息编号")
    listing.add_argument("--author", choices=PARTICIPANTS)
    listing.add_argument("--mention", choices=PARTICIPANTS)
    listing.add_argument("--kind", choices=KINDS, help="筛选观点、主持说明或运行回执")
    listing.add_argument("--submission-id", type=submission_id, help="按提交编号精确查询结果")
    view = add_leaf(subcommands, registry, "message view", "读取一条精确原文与来源", True)
    view.add_argument("id", type=positive_int, help="消息编号")
    post = add_leaf(subcommands, registry, "message post", "提交观点、主持说明、代发或运行回执", True)
    add_text(post, "body")
    post.add_argument("--attachment", action="append", type=attachment_id, default=[],
                      help="已上传附件 ID；可重复指定，最多 10 个")
    add_text(post, "summary")
    post.add_argument("--summary-by", choices=PARTICIPANTS, help="摘要撰写者：原作者或实际操作者；默认操作者")
    post.add_argument("--author", choices=PARTICIPANTS, help="原作者；默认等于 --as；不同即代发")
    post.add_argument("--kind", choices=KINDS, default="opinion")
    post.add_argument("--turn", type=positive_int, help="所回答的安排编号，仅 opinion 可用")
    post.add_argument("--reply-to", type=positive_int, help="被引用的原文编号")
    post.add_argument("--submission-id", type=submission_id, required=True,
                      help="每次新提交的唯一编号；重试必须沿用同编号和正文")


def attachment_commands(subcommands, registry):
    """Expose explicit upload, bounded discovery, and binary downloads."""
    listing = add_leaf(subcommands, registry, "attachment list", "分页读取已发送附件；按提交编号核对上传", True)
    listing.add_argument("--page", type=positive_int, default=1)
    listing.add_argument("--message", type=positive_int, help="只读指定消息的附件")
    listing.add_argument("--submission-id", type=submission_id, help="核对一次上传，包含尚未发送的文件")
    view = add_leaf(subcommands, registry, "attachment view", "读取文件名、类型、大小与下载地址", True)
    view.add_argument("id", type=attachment_id)
    upload = add_leaf(subcommands, registry, "attachment upload", "上传原文件；之后用 message post --attachment 关联消息", True)
    upload.add_argument("--file", required=True, help="本地原文件路径；最多 20 MiB")
    upload.add_argument("--submission-id", type=submission_id, required=True)
    download = add_leaf(subcommands, registry, "attachment download", "下载原文件到显式路径；不覆盖已有文件", True)
    download.add_argument("id", type=attachment_id)
    download.add_argument("--dest", required=True, help="保存文件的完整或相对路径；父目录须已存在")


def turn_commands(subcommands, registry):
    """Keep planning, notification text, and delivery confirmation distinct."""
    descriptions = {"list": "分页读取安排历史", "current": "读取阶段和最近安排；需核对状态及专家",
                    "view": "读取一个安排", "prompt": "生成简短通知；不发送、不标记送达",
                    "create": "安排一位专家，或用 --plan-file 一次安排整轮；不发送通知",
                    "continue": "处理用户操作或打断后，按原排队继续下一位",
                    "mark-notified": "实际送达后显式确认", "cancel": "取消指定未完成安排"}
    for action, description in descriptions.items():
        parser = add_leaf(subcommands, registry, f"turn {action}", description, True)
        if action == "list":
            parser.add_argument("--page", type=positive_int, default=1)
            parser.add_argument("--submission-id", type=submission_id, help="按安排提交编号精确查询结果")
        elif action not in ("create", "current", "continue"):
            parser.add_argument("id", type=positive_int, help="安排编号")
        if action == "create":
            parser.add_argument("--expert", choices=PARTICIPANTS[1:], help="单个安排的专家；与 --plan-file 二选一")
            add_text(parser, "question")
            parser.add_argument("--plan-file", help='整轮安排 JSON 数组 [{"expert":"Claude","question":"…"}]，按顺序接力；- 从标准输入读取')
            parser.add_argument("--submission-id", type=submission_id, required=True,
                                help="新安排唯一编号；重试沿用同编号和内容")


def state_commands(subcommands, registry):
    """Register separately requested host summaries with explicit cutoffs."""
    add_leaf(subcommands, registry, "state view", "读取主持摘要及材料截止编号", True)
    parser = add_leaf(subcommands, registry, "state set", "保存主持摘要；不自动推定已读范围", True)
    add_text(parser, "body", required=True)
    add_text(parser, "brief")
    parser.add_argument("--until", type=int, required=True, help="实际已读的材料截止编号，可为 0")


def floor_commands(subcommands, registry):
    """Expose explicit floor inspection, nominated claims and early returns."""
    add_leaf(subcommands, registry, "floor view", "读取当前持有者、下一位与版本", True)
    for action in ("take", "return"):
        parser = add_leaf(subcommands, registry, f"floor {action}", "领取或归还发言权", True)
        parser.add_argument("--speaker", choices=PARTICIPANTS, help="实际持有者；代操作时显式指定，默认 --as")
        parser.add_argument("--revision", type=non_negative_int, required=True, help="刚读取的发言权版本；变化后需重新核对")


def run_commands(subcommands, registry):
    """Expose mode and lifecycle controls independently of discussion phases."""
    for action in ("view", "configure", "start", "pause", "stop"):
        parser = add_leaf(subcommands, registry, f"run {action}", "查看或显式控制讨论运行", True)
        if action != "view":
            parser.add_argument("--revision", type=non_negative_int, required=True)
            parser.add_argument("--mode", choices=("manual", "automatic"))
        if action == "start":
            parser.add_argument("--deadline", type=non_negative_int, help="截止时间 Unix 秒数；0 表示不限时长，仍受话题上限约束；省略时使用话题上限")
            parser.add_argument("--phase", choices=("initial", "discussing", "reviewing"))


def execution_commands(subcommands, registry):
    """Enter one delivered task; duplicate enters cannot start duplicate work."""
    for action in ("view", "enter", "fail"):
        parser = add_leaf(subcommands, registry, f"execution {action}", "读取、进入或报告本次执行失败", True)
        parser.add_argument("id", type=positive_int)
        if action == "enter":
            parser.add_argument("--session-id", help="实际软件会话 ID，默认从受限任务文件读取")
        if action == "fail":
            parser.add_argument("--reason", required=True)


def build_parser(prog="discuss"):
    """Build help and schema from the same command definitions."""
    parser = Parser(prog=prog, description="AI CoDiscuss CLI：通过 HTTP 操作现有讨论网站。",
                    allow_abbrev=False, epilog="站点用 --site 或 DISCUSS_URL；不保存当前房间，不自动重试写入。")
    add_common(parser)
    parser.add_argument("--version", action="version", version=f"{prog} {VERSION}")
    subcommands = parser.add_subparsers(dest="resource", required=True)
    registry = {}
    for name, register in (("room", room_commands), ("message", message_commands),
                           ("attachment", attachment_commands),
                           ("turn", turn_commands), ("state", state_commands), ("floor", floor_commands),
                           ("run", run_commands), ("execution", execution_commands)):
        group = subcommands.add_parser(name, help=f"{name} 操作", allow_abbrev=False)
        add_common(group)
        register(group.add_subparsers(dest="action", required=True), registry)
    add_leaf(subcommands, registry, "health", "检查目标站点的 HTTP 健康接口")
    api = add_leaf(subcommands, registry, "api", "直接调用本站 /api 或 /r；请求体原样传送")
    api.add_argument("path", help="本站路径，可含查询参数；禁止完整 URL")
    api.add_argument("--method", choices=("GET", "POST"), default="GET")
    api.add_argument("--input", help="POST JSON 对象文件；- 从标准输入读取")
    schema = add_leaf(subcommands, registry, "schema", "离线列出命令或指定命令的参数约定")
    schema.add_argument("command", nargs="*", help="例如 message post；为空时列出全部命令")
    return parser, registry


def read_input(path):
    """Read UTF-8 content, accepting a BOM and at most one stdin consumer."""
    if path == "-":
        if sys.stdin.isatty():
            raise CliError("--*-file - / --input - 需要通过管道提供标准输入")
        return sys.stdin.read().lstrip("\ufeff")
    try:
        return Path(path).read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        raise CliError(f"无法读取 UTF-8 文件 {path}: {error}") from error


def read_object(path):
    """Require a JSON object rather than silently accepting arrays or scalars."""
    try:
        value = json.loads(read_input(path))
    except ValueError as error:
        raise CliError(f"无效 JSON: {error}") from error
    if not isinstance(value, dict):
        raise CliError("JSON 文件必须包含对象")
    return value


def text_field(args, field):
    """Read one literal or file-backed field without altering its content."""
    values = vars(args)
    path = values.get(f"{field}_file")
    return read_input(path) if path is not None else values.get(field)


def require_actor(args):
    """Require an explicit declared operator for domain writes."""
    actor = getattr(args, "actor", None)
    if not actor:
        raise CliError("写入必须显式指定 --as；该字段声明操作者，不提供身份认证")
    return actor


def topic_payload(args):
    """Collect only supplied topic fields; expert configuration is a full map."""
    payload = {}
    limits = {key: getattr(args, key) for key in ("max_rounds", "max_minutes", "execution_minutes", "on_limit", "summary_minutes") if hasattr(args, key)}
    if limits:
        payload["limits"] = limits
    for field in ("title", "goal", "user_request", "background", "boundaries", "focus"):
        value = text_field(args, field)
        if value is not None:
            payload[field] = value
    for field in ("host", "phase"):
        if hasattr(args, field):
            payload[field] = getattr(args, field)
    if hasattr(args, "experts_file"):
        experts = read_object(args.experts_file)
        if any(name not in PARTICIPANTS[1:] or mode not in ("cli", "online")
               for name, mode in experts.items()):
            raise CliError("专家映射的名称必须是有效 AI，模式必须是 cli 或 online")
        payload["experts"] = experts
    return payload


def plan_room(args):
    """Translate room operations to one existing HTTP endpoint."""
    if args.action == "list":
        params = {"submission_id": args.submission_id} if args.submission_id else None
        return RequestPlan("/api/rooms", view="room_list", params=params)
    if args.action == "create":
        payload = topic_payload(args)
        payload.setdefault("host", require_actor(args))
        payload["submission_id"] = args.submission_id
        if args.folder_id is not None:
            payload["folder_id"] = args.folder_id
        return RequestPlan("/api/rooms", "POST", payload, "overview")
    base = f"/api/rooms/{args.room}"
    if args.action == "limits":
        return RequestPlan(base + "/limits", "POST", {"actor": require_actor(args)}, "overview") if args.check else RequestPlan(base + "/limits")
    if args.action == "update":
        payload = topic_payload(args)
        if not payload:
            raise CliError("room update 至少需要一个话题字段")
        payload["actor"] = require_actor(args)
        return RequestPlan(base + "/topic", "POST", payload, "overview")
    if args.action == "protocol":
        return RequestPlan(f"/r/{args.room}/protocol")
    return RequestPlan(base, view="brief" if args.action == "brief" else "overview")


def plan_message(args):
    """Preserve operator, original author, message role, and replay identifier."""
    base = f"/api/rooms/{args.room}/messages"
    if args.action == "view":
        return RequestPlan(f"{base}/{args.id}")
    if args.action == "list":
        params = {"page": args.page, "q": args.query, "author": args.author, "mention": args.mention,
                  "after": args.after, "kind": args.kind, "submission_id": args.submission_id}
        return RequestPlan(base, params={key: value for key, value in params.items() if value is not None})
    actor = require_actor(args)
    if args.turn and args.kind != "opinion":
        raise CliError("只有 opinion 可以关联 --turn；receipt 不完成安排")
    payload = {"author": args.author or actor, "submitted_by": actor, "source": "cli",
               "kind": args.kind, "text": text_field(args, "body") or "", "submission_id": args.submission_id}
    if len(args.attachment) > MAX_MESSAGE_ATTACHMENTS or len(set(args.attachment)) != len(args.attachment):
        raise CliError("每条消息最多 10 个附件，不能重复")
    if args.attachment:
        payload["attachment_ids"] = args.attachment
    if (not payload["text"].strip() and not args.attachment) or len(payload["text"].strip()) > MAX_TEXT_LENGTH:
        raise CliError(f"发言需包含正文或附件，正文最多 {MAX_TEXT_LENGTH} 个 Unicode 字符；不会自动截断或分段")
    summary = text_field(args, "summary")
    if summary is not None:
        if len(summary.strip()) > MAX_SUMMARY_LENGTH:
            raise CliError(f"回答摘要最多 {MAX_SUMMARY_LENGTH} 个 Unicode 字符；不会自动截断")
        payload["summary"] = summary
    if args.summary_by:
        payload["summary_by"] = args.summary_by
    if args.turn:
        payload["turn_id"] = args.turn
    if args.reply_to:
        payload["reply_to"] = args.reply_to
    return RequestPlan(base, "POST", payload)


def plan_attachment(args):
    """Keep file bytes outside JSON messages and all storage targets explicit."""
    base = f"/api/rooms/{args.room}/attachments"
    if args.action == "list":
        params = {"page": args.page, "message_id": args.message, "submission_id": args.submission_id}
        return RequestPlan(base, params={key: value for key, value in params.items() if value is not None})
    if args.action == "upload":
        path = Path(args.file)
        try:
            if not path.is_file() or path.stat().st_size > MAX_ATTACHMENT_BYTES:
                raise CliError("上传路径须为文件，大小最多 20 MiB")
        except OSError as error:
            raise CliError(f"无法读取上传文件: {error}") from error
        metadata = {"actor": require_actor(args), "file_name": path.name, "submission_id": args.submission_id}
        return RequestPlan(base, "POST", params=metadata, upload_file=str(path))
    if args.action == "download":
        destination = Path(args.dest)
        if destination.exists() or not destination.parent.is_dir():
            raise CliError("--dest 须为不存在的文件路径，且父目录已存在；不会覆盖文件")
        return RequestPlan(f"{base}/{args.id}/content", params={"download": "1"}, download_file=str(destination))
    return RequestPlan(f"{base}/{args.id}")


def plan_turn(args):
    """Separate creating an assignment from external notification delivery."""
    base = f"/api/rooms/{args.room}"
    if args.action == "current":
        return RequestPlan(base, view="current")
    if args.action == "list":
        params = {"page": args.page}
        if args.submission_id:
            params["submission_id"] = args.submission_id
        return RequestPlan(base + "/turns", params=params)
    if args.action == "create":
        return RequestPlan(base + "/turns", "POST", turn_payload(args))
    if args.action == "continue":
        return RequestPlan(base + "/turns/continue", "POST", {"actor": require_actor(args)})
    path = f"{base}/turns/{args.id}"
    if args.action in ("mark-notified", "cancel"):
        status = "notified" if args.action == "mark-notified" else "cancelled"
        return RequestPlan(path, "POST", {"actor": require_actor(args), "status": status})
    return RequestPlan(path, view="prompt" if args.action == "prompt" else None)


def turn_payload(args):
    """Build one arrangement or an ordered round plan from a UTF-8 JSON array."""
    payload = {"actor": require_actor(args), "submission_id": args.submission_id}
    question = text_field(args, "question")
    if args.plan_file is not None:
        if args.expert or question is not None:
            raise CliError("--plan-file 不能与 --expert / --question 同时使用")
        try:
            turns = json.loads(read_input(args.plan_file))
        except ValueError as error:
            raise CliError(f"无效 JSON: {error}") from error
        if not isinstance(turns, list) or not all(isinstance(item, dict) for item in turns):
            raise CliError("--plan-file 必须是由 expert、question 对象组成的数组")
        return {**payload, "turns": turns}
    if not args.expert or question is None:
        raise CliError("需要 --expert 与 --question/--question-file，或改用 --plan-file")
    return {**payload, "expert": args.expert, "question": question}


def plan_floor(args):
    """Send one versioned operation without silently claiming on a failed write."""
    path = f"/api/rooms/{args.room}/floor"
    if args.action == "view":
        return RequestPlan(path)
    actor = require_actor(args)
    return RequestPlan(path, "POST", {"actor": actor, "speaker": args.speaker or actor,
                                      "action": args.action, "revision": args.revision})


def plan_state(args):
    """Keep a host summary's cutoff explicit instead of assuming latest means read."""
    base = f"/api/rooms/{args.room}"
    if args.action == "view":
        return RequestPlan(base, view="state")
    if args.until < 0:
        raise CliError("--until 不能小于 0")
    payload = {"actor": require_actor(args), "text": text_field(args, "body"), "until": args.until}
    brief = text_field(args, "brief")
    if brief is not None:
        if len(brief.strip()) > MAX_BRIEF_LENGTH:
            raise CliError(f"主持简报最多 {MAX_BRIEF_LENGTH} 个 Unicode 字符；不会自动截断")
        payload["brief"] = brief
    return RequestPlan(base + "/state", "POST", payload, "state")


def plan_api(args):
    """Allow literal HTTP requests only under the selected site's API/read roots."""
    path = urlsplit(args.path)
    decoded = unquote(path.path)
    if (path.scheme or path.netloc or path.fragment or "\\" in decoded
            or not decoded.startswith(("/api/", "/r/")) or ".." in decoded.split("/")):
        raise CliError("api 路径必须是本站 /api/... 或 /r/...，不能切换主机或包含 ..")
    if args.method == "GET" and args.input:
        raise CliError("GET 不接受 --input；查询条件直接写在路径中")
    if args.method == "POST" and not args.input:
        raise CliError("POST 需要 --input JSON文件（或 -）")
    return RequestPlan(args.path, args.method, read_object(args.input) if args.input else None)


def plan_run(args):
    """Build one versioned lifecycle operation without starting a daemon."""
    path = f"/api/rooms/{args.room}/runtime"
    if args.action == "view":
        return RequestPlan(path)
    body = {"action": args.action, "revision": args.revision}
    for key in ("mode", "deadline", "phase"):
        if getattr(args, key, None) is not None:
            body[key] = getattr(args, key)
    return RequestPlan(path, "POST", body)


def plan_execution(args):
    """Use the bound actual session when acknowledging a delivered execution."""
    body = {"action": args.action}
    if args.action == "enter":
        access = read_object(args.access_file) if getattr(args, "access_file", None) else {}
        body["session_id"] = args.session_id or access.get("session_id")
        if not body["session_id"]:
            raise CliError("尚未取得实际 session_id，请先核对接入回执")
    if args.action == "fail":
        body["reason"] = args.reason
    return RequestPlan(f"/api/rooms/{args.room}/events/{args.id}", "POST", body)


def build_plan(args):
    """Validate local input before constructing any network request."""
    stdin_count = sum(value == "-" for key, value in vars(args).items()
                      if key.endswith("_file") or key == "input")
    if stdin_count > 1:
        raise CliError("一次命令只能有一个字段从标准输入读取")
    handlers = {"room": plan_room, "message": plan_message, "turn": plan_turn,
                "attachment": plan_attachment,
                "state": plan_state, "floor": plan_floor, "api": plan_api,
                "run": plan_run, "execution": plan_execution}
    plan = RequestPlan("/api/health") if args.resource == "health" else handlers[args.resource](args)
    if getattr(args, "dry_run", False) and plan.method != "POST" and plan.download_file is None:
        raise CliError("--dry-run 仅用于写入命令；读取命令本身不会修改数据")
    if plan.body is not None and len(json.dumps(plan.body, ensure_ascii=False).encode("utf-8")) > MAX_BODY_BYTES:
        raise CliError(f"请求体超过服务端限制 {MAX_BODY_BYTES} 字节")
    return plan


def resolve_site(args):
    """Resolve an explicit flag or environment URL without implicit production writes."""
    site = getattr(args, "site", None) or os.getenv("DISCUSS_URL", "")
    parsed = urlsplit(site)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise CliError("请用 --site 或 DISCUSS_URL 指定 http(s)://主机[:端口]，不带路径、凭据或查询")
    try:
        parsed.port
    except ValueError as error:
        raise CliError(str(error)) from error
    return site.rstrip("/")


def decode_response(response, plan):
    """Decode the expected payload while identifying uncertain write responses."""
    if plan.download_file is not None:
        return save_attachment_response(response, plan.download_file)
    try:
        text = response.read().decode("utf-8-sig")
        if plan.path.startswith("/r/") and plan.method == "GET":
            if "text/plain" not in response.headers.get("Content-Type", ""):
                raise ValueError("预期纯文本响应")
            return text
        value = json.loads(text)
        if not isinstance(value, dict):
            raise ValueError("预期 JSON 对象")
        return value
    except (ValueError, UnicodeError) as error:
        raise CliError("响应不是预期的 UTF-8 / JSON 内容", 3,
                       outcome="unknown" if plan.method == "POST" else "unavailable") from error


def save_attachment_response(response, destination):
    """Validate a complete bounded response before creating an exclusive local file."""
    data = response.read(MAX_ATTACHMENT_BYTES + 1)
    size_header = response.headers.get("Content-Length")
    if len(data) > MAX_ATTACHMENT_BYTES or (size_header and len(data) != int(size_header)):
        raise CliError("附件下载不完整或超过 20 MiB；未保存文件", 3, outcome="unavailable")
    digest = hashlib.sha256(data).hexdigest()
    if response.headers.get("X-Content-SHA256", digest) != digest:
        raise CliError("附件校验失败；未保存文件", 3, outcome="unavailable")
    path = Path(destination)
    created = False
    try:
        with path.open("xb") as target:
            created = True
            target.write(data)
    except OSError as error:
        if created:
            path.unlink(missing_ok=True)
        raise CliError(f"无法保存附件；不会覆盖已有文件: {error}") from error
    return {"path": str(path.resolve()), "size": len(data), "sha256": digest}


def request_data(plan):
    """Load a bounded file for binary upload, or encode ordinary JSON requests."""
    if plan.upload_file is not None:
        try:
            with Path(plan.upload_file).open("rb") as source:
                data = source.read(MAX_ATTACHMENT_BYTES + 1)
        except OSError as error:
            raise CliError(f"无法读取上传文件: {error}") from error
        if len(data) > MAX_ATTACHMENT_BYTES:
            raise CliError("单个附件最多 20 MiB")
        return data
    return json.dumps(plan.body, ensure_ascii=False).encode("utf-8") if plan.body is not None else None


def http_error(error, plan):
    """Retain useful API errors and distinguish rejected from uncertain writes."""
    try:
        body = error.read().decode("utf-8")
        value = json.loads(body)
        message = value.get("error", body) if isinstance(value, dict) else body
    except (ValueError, UnicodeError, OSError, HTTPException):
        message = f"HTTP {error.code}: {error.reason}"
    uncertain = plan.method == "POST" and error.code >= 500
    return CliError(str(message), 1, http_status=error.code,
                    outcome="unknown" if uncertain else "rejected")


def send_request(plan, url, timeout, headers=None):
    """Send exactly once, preserving TLS verification and bounded waiting."""
    data = request_data(plan)
    content_type = "application/octet-stream" if plan.upload_file is not None else "application/json"
    request = Request(url, data=data, method=plan.method,
                      headers={"Content-Type": content_type, "Accept": "*/*" if plan.download_file else "application/json, text/plain",
                               "User-Agent": f"AI-CoDiscuss-CLI/{VERSION}", **(headers or {})})
    try:
        with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
            return decode_response(response, plan)
    except HTTPError as error:
        with error:
            raise http_error(error, plan) from error
    except (URLError, OSError, HTTPException) as error:
        raise CliError(f"网络请求失败: {error}", 3,
                       outcome="unknown" if plan.method == "POST" else "unavailable") from error


def select_fields(value, names):
    """Project explicitly requested fields without expanding additional context."""
    return {name: value[name] for name in names if name in value}


def project_result(value, plan, site):
    """Keep summaries, briefing material, host state, and original text separate."""
    if plan.view == "room_list":
        return {"rooms": [select_fields(room, ROOM_LIST_FIELDS) for room in value["rooms"]]}
    if plan.view in ("overview", "brief", "state", "current"):
        fields = {"overview": OVERVIEW_FIELDS, "brief": BRIEF_FIELDS,
                  "state": ("id", "state_text", "state_until", "host_brief", "latest_receipts", "answered_turns"),
                  "current": ("id", "phase", "current_turn", "queued_turns", "held_since", "floor", "answered_turns")}[plan.view]
        result = select_fields(value, fields)
        if plan.view in ("overview", "current"):
            result["guidance"] = GUIDANCE.get(value["phase"], "按本次主持或专家职责，结合最新阶段、安排和必要原文决定下一步。")
            result["url"] = f"{site}/r/{value['id']}"
        return result
    if plan.view == "prompt":
        entry = f"{site}/r/{value['room_id']}?participant={value['expert']}"
        prompt = f"请 {value['expert']} 回应：{value['question']}\n安排编号：{value['id']}\n按需阅读：{entry}\n回答附简短摘要及完整正文，保留关键条件和不确定性。"
        return {"turn_id": value["id"], "status": value["status"], "prompt": prompt,
                "delivery": "未发送；仅生成文字，实际通知后使用 turn mark-notified"}
    return value


def command_schema(args, registry):
    """Describe available commands and fields from the live argparse registry."""
    name = " ".join(args.command)
    if not name:
        return {"version": VERSION, "commands": {key: item.description for key, item in registry.items()},
                "exit_codes": EXIT_CODES, "site": "--site > DISCUSS_URL；无内置默认站点",
                "output": "默认 JSON；成功 stdout，错误 stderr；无交互提示、无自动重试"}
    if name not in registry:
        raise CliError(f"未知命令 {name}；运行 discuss schema 查看可用命令")
    parser = registry[name]
    arguments = []
    for action in parser._actions:
        if action.dest == "help":
            continue
        item = {"name": action.dest, "flags": action.option_strings,
                "required": action.required, "help": action.help}
        if action.dest == "actor" and name in ("room create", "room update", "message post",
                                               "turn create", "turn mark-notified", "turn cancel", "state set", "attachment upload"):
            item["required"] = True
        if action.choices is not None:
            item["choices"] = list(action.choices)
        if action.default not in (argparse.SUPPRESS, None):
            item["default"] = action.default
        arguments.append(item)
    groups = [{"one_of": [item.dest for item in group._group_actions], "required": group.required}
              for group in parser._mutually_exclusive_groups]
    return {"command": name, "description": parser.description, "arguments": arguments,
            "exclusive_groups": groups, "scope": "CLI 参数约定；服务端协议见 room protocol"}


def text_output(value):
    """Render readable text while retaining complete message bodies and IDs."""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        lines = []
        for key, item in value.items():
            if isinstance(item, (dict, list)):
                lines.append(f"{key}:\n{text_output(item)}")
            else:
                lines.append(f"{key}: {item if item is not None else '—'}")
        return "\n".join(lines)
    if isinstance(value, list):
        return "\n\n".join(text_output(item) for item in value) or "（空）"
    return str(value)


def emit(value, output="json", error=False):
    """Write the stable JSON envelope or human text to the correct stream."""
    stream = sys.stderr if error else sys.stdout
    if output == "json":
        rendered = json.dumps(value, ensure_ascii=False, indent=2)
    else:
        rendered = text_output(value if error else value["data"])
    stream.write(rendered + "\n")
    stream.flush()


def access_headers(args, site, path):
    """Load a room-scoped secret only for its exact site and room."""
    if not getattr(args, "access_file", None):
        return {}
    access = read_object(args.access_file)
    expected = f"/api/rooms/{access.get('room', '')}"
    target = urlsplit(path).path
    if access.get("site", "").rstrip("/") != site or not (target == expected or target.startswith(expected + "/")):
        raise CliError("凭据文件不属于本次站点和房间")
    token = access.get("token")
    if not isinstance(token, str) or not 32 <= len(token) <= 256:
        raise CliError("凭据文件中的 token 无效")
    return {"X-Discussion-Token": token}


def run(args, registry):
    """Execute a parsed command, with schema and previews remaining offline."""
    if args.resource == "schema":
        return {"ok": True, "data": command_schema(args, registry)}
    plan = build_plan(args)
    site = resolve_site(args)
    timeout = getattr(args, "timeout", DEFAULT_TIMEOUT)
    if not math.isfinite(timeout) or timeout <= 0:
        raise CliError("--timeout 必须为有限正数")
    url = site + plan.path
    if plan.params:
        url += "?" + urlencode(plan.params)
    meta = {"site": site, "method": plan.method, "path": plan.path}
    if getattr(args, "dry_run", False):
        return {"ok": True, "data": {"method": plan.method, "url": url, "body": plan.body,
                                   **({"file": plan.upload_file} if plan.upload_file else {}),
                                   **({"destination": plan.download_file} if plan.download_file else {})},
                "meta": {**meta, "dry_run": True, "validation": "仅本地参数；未验证房间、身份或服务端状态"}}
    try:
        headers = access_headers(args, site, plan.path)
        value = send_request(plan, url, timeout, headers) if headers else send_request(plan, url, timeout)
        result = project_result(value, plan, site)
    except CliError as error:
        error.details.update(meta)
        if plan.method == "POST":
            error.details["submission_id"] = (plan.body or plan.params or {}).get("submission_id")
            error.details["hint"] = "未自动重试。创建结果未知时用对应 list --submission-id 查询；确认需要重试才沿用原编号和原始内容。"
        raise
    except (KeyError, TypeError) as error:
        raise CliError("响应结构与 CLI 不兼容，请用 api 命令检查服务版本", 3,
                       **meta, outcome="unknown" if plan.method == "POST" else "unavailable") from error
    return {"ok": True, "data": result, "meta": meta}


def main(argv=None):
    """Run the CLI without prompts; return documented process exit codes."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    args = None
    try:
        parser, registry = build_parser(prog=os.getenv("DISCUSS_CLI_NAME", "discuss"))
        args = parser.parse_args(argv)
        emit(run(args, registry), getattr(args, "output", "json"))
        return 0
    except CliError as error:
        output = getattr(args, "output", "json")
        emit({"ok": False, "error": {"message": str(error), "exit_code": error.code, **error.details}},
             output, error=True)
        return error.code
    except (ValueError, UnicodeError, OSError) as error:
        emit({"ok": False, "error": {"message": str(error), "exit_code": 2}}, error=True)
        return 2
    except KeyboardInterrupt:
        emit({"ok": False, "error": {"message": "已中断；若正在写入，请先读取记录核对结果。",
                                      "exit_code": 130, "outcome": "unknown"}}, error=True)
        return 130


if __name__ == "__main__":
    sys.exit(main())
