#!/usr/bin/env python3
"""AI CoDiscuss 命令行客户端：显式目标、按需读取、可重放的 HTTP 写入。"""

import argparse
import hashlib
import hmac
import http.client
import json
import math
import os
import re
import secrets
import sys
import tempfile
import time
from dataclasses import dataclass
from http.client import HTTPException
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

VERSION = "0.2.0"
DEFAULT_TIMEOUT = 20
# A refused connection never reached the site, so resending is safe; the local site is back within seconds of an upgrade restart.
REFUSED_RETRY_SECONDS = 10
REFUSED_RETRY_INTERVAL = 1.0
MAX_BODY_BYTES = 512 * 1024
MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024
MAX_MESSAGE_ATTACHMENTS = 10
# Environment variables a hosting AI session exposes its own ID through, with the client name the room records.
SESSION_VARIABLES = (("CLAUDE_CODE_SESSION_ID", "claude"), ("CODEX_THREAD_ID", "codex"), ("ANTIGRAVITY_CONVERSATION_ID", "antigravity"))
MAX_TEXT_LENGTH = 32000
MAX_SUMMARY_LENGTH = 1000
MAX_BRIEF_LENGTH = 1600
MAX_MEMBER_HANDLE = 80
PARTICIPANTS = ("用户", "Codex", "Claude", "Antigravity", "DeepSeek", "Qwen", "Grok", "OpenAI", "Custom")
# A platform is a type; `Claude-review` is a second Claude instance with its own session. Mirrors backend/identity.py.
INSTANCE_PATTERN = re.compile(r"(Codex|Claude|Antigravity|DeepSeek|Qwen|Grok|OpenAI|Custom)(?:-[0-9A-Za-z_]{1,16})?")
KINDS = ("opinion", "moderation", "chat")
OVERVIEW_FIELDS = ("id", "title", "goal", "host", "phase", "focus", "message_count",
                   "latest_id", "state_until", "current_turn", "queued_turns", "held_since", "limits", "completed_rounds", "answered_turns", "duplicate", "submission_id",
                   "mode", "members", "free", "descriptions", "experts")
# Agent tools cut long command output (Claude Code past 30000 characters, Codex CLI past 10000 tokens), so a page stays inside both.
LIST_OUTPUT_CHARS = 8000
# The room view keeps live work and a short recent trail; `execution view` reads any one execution in full.
RECENT_EXECUTIONS = 10
EXECUTION_FIELDS = ("id", "member", "status", "result", "answer_id", "request_message_id", "changes", "late_answer")
TERMINAL_STATUSES = ("completed", "cancelled", "failed")
GUIDANCE = {
    "initial": "先基于目标、背景和边界独立形成观点；提交前不读他人观点或主持总结。",
    "paused": "停止处理安排并停止本讨论自己的后台任务，核对实际状态。",
    "concluded": "话题已收束；停止本讨论自己的后台任务并核对实际状态。",
}
BRIEF_FIELDS = ("id", "title", "goal", "host", "user_request", "background", "boundaries", "experts")
ROOM_LIST_FIELDS = ("id", "title", "goal", "message_count", "latest_id", "created_at")
# A posted message echoes only what proves where it landed; the full text stays one `message view` away.
RECEIPT_FIELDS = ("id", "author", "kind", "execution_id", "request_message_id", "reply_to", "submission_id",
                  "created_at", "summary", "proactive")
EXIT_CODES = {"0": "成功", "1": "HTTP/API 错误", "2": "参数或输入错误",
              "3": "网络失败或响应无法确认", "130": "被中断，写入结果需核对"}


class CliError(Exception):
    """Carry a stable exit code and machine-readable error details."""

    def __init__(self, message, code=2, **details):
        super().__init__(message)
        self.code = code
        self.details = details


# Shells split a literal text argument when it holds quotes they treat as delimiters; Windows PowerShell also treats
# Chinese curly quotes as quotes, which surfaces here as leftover arguments.
UNRECOGNIZED_HINT = "正文或摘要可能被 shell 按引号或空格截断（Windows PowerShell 也把中文弯引号当引号）：改用 --body-file / --summary-file 传文本。"


class Parser(argparse.ArgumentParser):
    """Report parser failures through the same stderr contract as API errors."""

    def error(self, message):
        """Raise a usage error instead of printing a separate argparse format."""
        hint = f"查看 {self.prog} --help"
        if message.startswith("unrecognized arguments"):
            hint = UNRECOGNIZED_HINT + hint
        raise CliError(message, hint=hint)


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


class JoinPreviousStep(argparse.Action):
    """`--with NAME`: append NAME to `--to` and remember that it shares the step of the member named just before it."""

    def __call__(self, parser, namespace, value, option_string=None):
        names = list(getattr(namespace, self.dest) or [])
        if not names:
            parser.error("--with 须跟在一个 --to 之后")
        names.append(value)
        setattr(namespace, self.dest, names)
        namespace.joined_steps = [*getattr(namespace, "joined_steps", []), len(names) - 1]


def parallel_groups(names, joined):
    """The `parallel` field from the `--to` list and the positions `--with` joined to the step before them."""
    groups = []
    for index in sorted(joined):
        if groups and groups[-1][-1] == names[index - 1]:
            groups[-1].append(names[index])
        else:
            groups.append([names[index - 1], names[index]])
    return groups


def repeat_gate(value):
    """`--repeat AFTER=START`: a loop's checkpoint after AFTER's step whose next pass starts at START's step."""
    after, separator, start = value.partition("=")
    if not separator:
        raise argparse.ArgumentTypeError("须写成 检查点成员=再来一圈的起点成员，如 批评家=写手")
    return {"after": member_handle(after), "repeat_from": member_handle(start)}


def user_gate(value):
    """`--wait-user AFTER[=START]`: after AFTER's step wait for the owner; their next message goes on, or reruns from START."""
    after, separator, start = value.partition("=")
    if separator and not start:
        raise argparse.ArgumentTypeError("须写成 成员 或 成员=再来一圈的起点成员，如 法师=地下城主")
    return {"after": member_handle(after), "user": True, **({"repeat_from": member_handle(start)} if separator else {})}


def positive_int(value):
    """Parse a positive page or resource identifier."""
    try:
        number = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("必须为正整数") from error
    if number < 1:
        raise argparse.ArgumentTypeError("必须为正整数")
    return number


def ai_name(value):
    """Accept an AI platform or a named instance of one, such as Claude-review."""
    if not INSTANCE_PATTERN.fullmatch(value):
        raise argparse.ArgumentTypeError("须为 Codex/Claude/Antigravity/DeepSeek/Qwen/Grok/OpenAI/Custom，或平台名-后缀（后缀 1–16 个英文字母、数字或下划线）")
    return value


def member_handle(value):
    """Accept a member as the room calls it: its display name (such as Gemini) or its ID; the site resolves and checks it."""
    value = value.strip()
    if not 0 < len(value) <= MAX_MEMBER_HANDLE:
        raise argparse.ArgumentTypeError(f"须为成员的显示名或 ID，1–{MAX_MEMBER_HANDLE} 字")
    return value


def participant(value):
    """Accept the user or any AI instance."""
    return value if value == PARTICIPANTS[0] else ai_name(value)


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


def fill_submission_id(args, plan):
    """Derive an omitted submission ID from the command and its content, so resending the same content is deduplicated
    without the caller generating an ID in the shell; the hosting session ID is left out because it does not change what is written."""
    target = next((part for part in (plan.body, plan.params) if isinstance(part, dict) and "submission_id" in part), None)
    if plan.method != "POST" or target is None or target["submission_id"]:
        return
    body = {key: value for key, value in (plan.body or {}).items() if key not in ("session_id", "session_client")}
    material = {"operation": args.operation, "room": getattr(args, "room", None), "body": body, "params": plan.params}
    if plan.upload_file:
        material["file"] = hashlib.sha256(Path(plan.upload_file).read_bytes()).hexdigest()
    digest = hashlib.sha256(json.dumps(material, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    target["submission_id"] = "auto-" + digest[:40]


def attachment_id(value):
    """Accept only opaque file identifiers, never local or remote paths."""
    if not re.fullmatch(r"[a-f0-9]{32}", value):
        raise argparse.ArgumentTypeError("附件 ID 需为服务端返回的 32 位小写十六进制编号")
    return value


def add_common(parser):
    """Allow common flags before or after subcommands without shared state."""
    options = {"default": argparse.SUPPRESS}
    parser.add_argument("--site", help="HTTP 服务地址；未指定时读 DISCUSS_URL，再读凭据中的 site", **options)
    parser.add_argument("--as", dest="actor", type=participant,
                        help="业务写入的声明操作者；省略时用凭据绑定的成员；不是登录认证；api 使用原始请求体", **options)
    parser.add_argument("-o", "--output", choices=("json", "text"),
                        help="默认 json；成功 stdout，错误 stderr", **options)
    parser.add_argument("--timeout", type=float, help="请求超时秒数，默认 20", **options)
    parser.add_argument("--dry-run", action="store_true", help="只预览写入请求，不联网", **options)
    parser.add_argument("--access-file", help="本房间的受限凭据 JSON 文件（- 读标准输入）；未指定时依次读取 DISCUSS_ACCESS_FILE 文件、DISCUSS_ACCESS JSON 文本；不输出其 token", **options)


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
    parser.add_argument("--host", type=participant, default=argparse.SUPPRESS,
                        help="主持人；创建时默认 --as 操作者")
    parser.add_argument("--experts-file", default=argparse.SUPPRESS,
                        help='完整参与者映射 JSON，如 {"Codex":"cli","Antigravity":"cli"}；替换整个映射')
    for name in ("max-rounds", "max-minutes"):
        parser.add_argument(f"--{name}", type=non_negative_int, default=argparse.SUPPRESS)
    # Accepted so older scripts keep working; one execution has no time limit any more.
    parser.add_argument("--execution-minutes", type=non_negative_int, default=argparse.SUPPRESS, help=argparse.SUPPRESS)


def add_leaf(subcommands, registry, name, description, needs_room=False):
    """Register one discoverable command and its common options."""
    parser = subcommands.add_parser(name.split()[-1], help=description, description=description,
                                   allow_abbrev=False)
    add_common(parser)
    parser.set_defaults(operation=name)
    if needs_room:
        parser.add_argument("room", type=room_id, nargs="?", help="房间 ID；省略时用凭据绑定的房间")
    registry[name] = parser
    return parser


def room_commands(subcommands, registry):
    """Register room discovery, progressive reading, creation, and updates."""
    for action, description in (("list", "列出房间概要"), ("view", "只读目标、阶段、成员与分工、当前安排；执行只列进行中与最近 10 次的要点，完整内容用 execution view"),
                                ("brief", "按需读取背景、边界和专家配置"),
                                ("conclusion", "收束前申请最新收束状态（阻碍项与 revision）；主持人收束前必做"),
                                ("protocol", "按需读取当前服务的参与协议")):
        parser = add_leaf(subcommands, registry, f"room {action}", description, action != "list")
        if action == "list":
            parser.add_argument("--submission-id", type=submission_id, help="按建房提交编号精确查询")
        elif action in ("view", "brief"):
            parser.add_argument("--request", type=positive_int, help="手动成员：按自己的有效请求限制可读原文")
    events = add_leaf(subcommands, registry, "room events",
                      "房主或当前主持人读取房间事件记录（主持人看不到私聊与消息正文）：用户与程序的每次写入（含被拒的）及其引起的状态变化，按发生顺序，用于排查问题；默认最新 500 条", True)
    paging = events.add_mutually_exclusive_group()
    paging.add_argument("--after", type=non_negative_int, help="只读此事件编号之后的记录")
    paging.add_argument("--before", type=non_negative_int, help="读此事件编号之前的一页；按返回的 more 继续向前")
    limits = add_leaf(subcommands, registry, "room limits", "查看上限；--check 检查并执行到限处理；--done 通知程序目标已完成", True)
    limits.add_argument("--check", action="store_true")
    limits.add_argument("--done", action="store_true", help="主持人宣告目标已完成：结束讨论，房间照常协作；须带 --conclusion")
    limits.add_argument("--conclusion", help="room conclusion 返回的 revision；--done 必填")
    create = add_leaf(subcommands, registry, "room create", "创建话题；不自动启动讨论或监控")
    create.add_argument("--folder-id", help="直接在指定文件夹中创建；省略则未归类")
    add_topic(create, create=True)
    create.add_argument("--submission-id", type=submission_id,
                        help="新话题唯一编号；未知结果先查询，重试沿用编号和原始资料。省略时按命令与内容自动生成，同样内容重试得到同一编号")
    update = add_leaf(subcommands, registry, "room update", "维护话题；省略的字段保持不变", True)
    add_topic(update)


def message_commands(subcommands, registry):
    """Register bounded search, exact reads, and attributed message writes."""
    listing = add_leaf(subcommands, registry, "message list", "检索原文：每次最多 20 条且不超过约 8000 字符，未列完时按 next_after 用 --after 续读", True)
    paging = listing.add_mutually_exclusive_group()
    paging.add_argument("--page", type=positive_int, default=1)
    paging.add_argument("--after", type=non_negative_int, help="只读此消息编号之后的内容；按 next_after 续读")
    listing.add_argument("--query", help="关键词或消息编号")
    listing.add_argument("--author", type=participant)
    listing.add_argument("--mention", type=participant)
    listing.add_argument("--kind", choices=KINDS, help="筛选观点、主持说明或协作消息")
    listing.add_argument("--submission-id", type=submission_id, help="按提交编号精确查询结果")
    listing.add_argument("--request", type=positive_int, help="手动成员：按自己的有效请求限制可读原文")
    view = add_leaf(subcommands, registry, "message view", "读取一条精确原文与来源", True)
    view.add_argument("id", type=positive_int, help="消息编号")
    view.add_argument("--request", type=positive_int, help="手动成员：按自己的有效请求限制可读原文")
    group = add_leaf(subcommands, registry, "message group-plan", "房主读取全体请求、成员、顺序与 revision；安排全体前先读，提交时携带该 revision", True)
    group.add_argument("id", type=positive_int, help="全体请求的原消息编号")
    post = add_leaf(subcommands, registry, "message post",
                    "提交观点、主持说明或协作回答；成功只返回回执（编号、作者、关联、摘要、正文字数），不回显正文。"
                    "--body-file 开头可用 `---` / `summary: 摘要` / `---` 三行携带摘要", True)
    add_text(post, "body")
    post.add_argument("--attachment", action="append", type=attachment_id, default=[],
                      help="已上传附件 ID；可重复指定，最多 10 个")
    add_text(post, "summary")
    post.add_argument("--kind", choices=("chat", "moderation"), default="chat")
    post.add_argument("--execution", type=positive_int, help="自由房间：本次执行编号；省略时用凭据绑定的执行。执行失效后不能改作普通发言；只被本机服务判失败、未被重试的执行仍收下回答")
    post.add_argument("--to", type=member_handle, action="append", default=[],
                      help="自由房间：主持人点名派活，普通成员提出回应建议（须房主确认）；可重复")
    post.add_argument("--handoff", action="store_true",
                      help="旧参数，保留兼容：主持人派出的工作现在总会交回你")
    post.add_argument("--no-handoff", action="store_true",
                      help="自由房间主持人：只点名一位成员、它的回答已足以直接给用户时用；做完不交回你，失败仍交回")
    post.add_argument("--proactive", action="store_true",
                      help="自由房间成员：不是房间派来的任务、而是你的用户在你自己的窗口里要你发言时用（主持人也可在需要主动说明、派活或补交失效执行的结果时自行使用）；不关联执行或请求，有进行中的执行或讨论进行中不可用；主持人还可同时 --to 派活或 --continue，从这条消息起算新任务链")
    post.add_argument("--continue", dest="continue_reason", metavar="REASON",
                      help="自由房间主持人：房间没有其他进行中的工作时再唤醒你一次，写明继续做什么（≤300 字）；算本链一轮，用户发新消息或你下次回答不带它即取消")
    post.add_argument("--sequential", action="store_true",
                      help="自由房间主持人：--to 点名的多位成员按点名顺序依次接力，走完一圈算一轮，最后一位做完交回你")
    post.add_argument("--loop", action="store_true",
                      help="与 --sequential 同用：交回成为检查点，用 sequence continue 开始下一圈，不继续即直接验收")
    post.add_argument("--checkpoint", type=member_handle, action="append", default=[], metavar="MEMBER",
                      help="与 --sequential 同用：该成员所在那一棒结束后交回你（检查点），你用 sequence continue 往下一棒走，直接回答即结束接力；可重复")
    post.add_argument("--repeat", type=repeat_gate, action="append", default=[], metavar="MEMBER=START",
                      help="与 --sequential 同用：MEMBER 所在那一棒结束后为循环检查点，sequence continue 从 START 所在那一棒再来一圈，加 --proceed 往下一棒走；START 不能早于前一个检查点；可重复")
    post.add_argument("--wait-user", type=user_gate, action="append", default=[], metavar="MEMBER[=START]",
                      help="与 --sequential 同用：MEMBER 所在那一棒结束后等用户发言，不交回你；用户下一条未点名的消息接着往下一棒走，"
                           "写了 =START 则从 START 所在那一棒再来一圈（最后一棒之后须写 START），该消息交给下一棒先读；可重复")
    post.add_argument("--detach", type=member_handle, action="append", default=[], metavar="MEMBER",
                      help="自由房间主持人：与 --to 同用，点名一位与这次派活同时开工、但不等它的成员（不计入交回或下一棒的等待）；它失败时程序通知你；可重复")
    post.add_argument("--with", dest="to", type=member_handle, action=JoinPreviousStep, metavar="MEMBER",
                      help="与 --sequential 同用：点名一位成员，与紧挨在前的 --to（或 --with）同一棒、同时做；这一组全部结束才交下一棒，组里有人失败则接力停下交回你；可重复")
    post.add_argument("--need-rounds", type=positive_int, metavar="N",
                      help="自由房间主持人：与 --to 同用，声明本任务从这次派活起还需要的轮数（须带 --rounds-reason）；超过本链剩余轮数时任务链立即停下，请用户一键批准差额")
    post.add_argument("--rounds-reason", metavar="REASON", help="与 --need-rounds 同用：为什么需要这些轮（≤300 字），展示给用户")
    post.add_argument("--next-review", type=member_handle, help="主持派实现时声明下一位只读评审；先读 review roster，不可指定本批实现者")
    post.add_argument("--review-scope", help="本批预授权评审范围，1–2000 字")
    post.add_argument("--review-roster", help="先读取 review roster 取得的 revision；状态变化须重读")
    post.add_argument("--request", type=positive_int, action="append", default=[],
                      help="自由房间手动接入成员：本次回答完成的请求编号，可重复；不能与 --execution 同用")
    post.add_argument("--reply-to", type=positive_int, help="被引用的原文编号")
    post.add_argument("--submission-id", type=submission_id,
                      help="每次新提交的唯一编号；重试必须沿用同编号和正文。省略时按房间、身份、关联与内容自动生成，同一份草稿重试得到同一编号")


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
    upload.add_argument("--submission-id", type=submission_id, help="上传唯一编号；省略时按命令与内容自动生成，同样内容重试得到同一编号")
    download = add_leaf(subcommands, registry, "attachment download", "下载原文件到显式路径；不覆盖已有文件", True)
    download.add_argument("id", type=attachment_id)
    download.add_argument("--dest", required=True, help="保存文件的完整或相对路径；父目录须已存在")


def turn_commands(subcommands, registry):
    """Read and control discussion plans through their dedicated operations."""
    descriptions = {"list": "分页读取安排历史",
                    "view": "读取一个安排",
                    "roster": "申请最新专家状态（在场专家、本轮待发言者与 revision）；整轮安排前必做",
                    "order": "读取发言顺序（已发言、正在发言、待发言与 revision）；调整顺序前必做",
                    "reorder": "房主调整尚未发言者的顺序（须带 turn order 的 --revision）；已发言与正在发言者不动",
                    "create": "安排一位专家，或用 --plan-file 一次安排整轮（须带最新 --roster）",
                    "continue": "处理用户操作或打断后，按原排队继续下一位",
                    "ask": "先读 turn roster，再将其中一条主持追问转为普通提问；不改变讨论队列",
                    "cancel": "取消指定未完成安排"}
    for action, description in descriptions.items():
        parser = add_leaf(subcommands, registry, f"turn {action}", description, True)
        if action == "list":
            parser.add_argument("--page", type=positive_int, default=1)
            parser.add_argument("--submission-id", type=submission_id, help="按安排提交编号精确查询结果")
        elif action not in ("create", "continue", "ask", "roster", "order", "reorder"):
            parser.add_argument("id", type=positive_int, help="安排编号")
        if action == "create":
            parser.add_argument("--expert", type=member_handle, help="单个安排的专家；与 --plan-file 二选一")
            add_text(parser, "question")
            parser.add_argument("--plan-file", help='整轮安排 JSON 数组 [{"expert":"Claude","question":"…"}]，按顺序接力；- 从标准输入读取')
            parser.add_argument("--roster", required=True, help="turn roster 返回的 revision；任何新安排前必读，专家状态变化后需重新获取")
            parser.add_argument("--submission-id", type=submission_id,
                                help="新安排唯一编号；重试沿用同编号和内容。省略时按命令与内容自动生成，同样内容重试得到同一编号")
        if action == "reorder":
            parser.add_argument("--revision", required=True, help="turn order 返回的 revision；顺序变化后需重新获取")
            parser.add_argument("--member", action="append", type=ai_name, required=True,
                                help="按新顺序重复指定，须恰好包含 turn order 中 movable 的全部成员")
        if action == "ask":
            parser.add_argument("--request", type=positive_int, required=True, help="turn roster 中 host_requests 的请求编号")
            parser.add_argument("--expert", type=member_handle, required=True, help="在场且已注册的目标成员，含已发言者和主持人")
            parser.add_argument("--submission-id", type=submission_id, help="转交唯一编号；重试沿用原编号与内容。省略时按命令与内容自动生成，同样内容重试得到同一编号")
        if action in ("continue", "ask"):
            parser.add_argument("--roster", required=True, help="turn roster 返回的 revision；状态变化后须重新读取")


def state_commands(subcommands, registry):
    """Register separately requested host summaries with explicit cutoffs."""
    view = add_leaf(subcommands, registry, "state view", "读取主持摘要及材料截止编号", True)
    view.add_argument("--request", type=positive_int, help="手动成员：按自己的有效请求限制可读原文")
    parser = add_leaf(subcommands, registry, "state set", "保存主持摘要；不自动推定已读范围", True)
    add_text(parser, "body", required=True)
    add_text(parser, "brief")
    parser.add_argument("--until", type=int, required=True, help="实际已读的材料截止编号，可为 0")
    decision = add_leaf(subcommands, registry, "state decision", "按编号读取本房间一条智能调度判断、完整输入及选项；先读问题原文，再自行判断", True)
    decision.add_argument("id", type=positive_int, help="任务 scheduler_suggestions 给出的决策记录编号")


def run_commands(subcommands, registry):
    """Expose discussion-session lifecycle controls independently of the resident service."""
    for action in ("view", "start", "pause", "resume", "stop"):
        parser = add_leaf(subcommands, registry, f"run {action}", "查看或显式控制讨论会话", True)
        if action not in ("view", "start"):
            parser.add_argument("--revision", required=True, help="run view 返回的 revision；状态变化后须重新读取")
        if action == "start":
            parser.add_argument("--revision", help="run view 返回的 revision（房主开启时用）")
            parser.add_argument("--request", type=positive_int,
                                help="主持人用：用户 /discuss 命令生成的 discuss_start 请求编号；只补全 --goal，上限用房间默认值")
            add_text(parser, "goal")
            for name in ("max-rounds", "max-minutes"):
                parser.add_argument(f"--{name}", type=non_negative_int, default=argparse.SUPPRESS)
            # Accepted so older scripts keep working; one execution has no time limit any more.
            parser.add_argument("--execution-minutes", type=non_negative_int, default=argparse.SUPPRESS, help=argparse.SUPPRESS)
            parser.add_argument("--submission-id", type=submission_id,
                                help="可选启动提交编号；重试须沿用编号和原请求")


def goal_commands(subcommands, registry):
    """Goal mode: read it, let the host fill in or end it, and let the owner control it."""
    add_leaf(subcommands, registry, "goal view", "读取 Goal 的目标、状态、续跑次数、用时、是否空闲与 revision；完成、卡住与续跑须先读", True)
    start = add_leaf(subcommands, registry, "goal start",
                     "主持人凭用户 /goal 命令生成的 goal_start 请求补全目标并开启（--request）；房主可带 --revision 直接开启", True)
    start.add_argument("--request", type=positive_int, help="任务 requests 中 purpose 为 goal_start 的请求编号（主持人用）")
    start.add_argument("--revision", help="goal view 返回的 revision（房主直接开启时用）")
    add_text(start, "objective")
    for action, help_text in (("done", "主持人对照实际状态核验后宣告 Goal 完成；先 goal view 取 revision"),
                              ("block", "同一阻碍连续 3 次续跑仍未解决时，主持人宣告 Goal 卡住并写明阻碍；先 goal view 取 revision")):
        parser = add_leaf(subcommands, registry, f"goal {action}", help_text, True)
        parser.add_argument("--revision", required=True, help="goal view 返回的 revision；状态变化后须重新读取")
        add_text(parser, "note")
    state = add_leaf(subcommands, registry, "goal state",
                     "主持人可选声明 Goal 当前状态：doing 推进中（空闲即唤醒）、waiting 等待后台工作、pending 待用户确认；"
                     "后两种不在空闲时唤醒，到时限兜底唤醒一次；先 goal view 取 revision", True)
    state.add_argument("--state", required=True, choices=("doing", "waiting", "pending"), help="要声明的状态")
    state.add_argument("--revision", required=True, help="goal view 返回的 revision；状态变化后须重新读取")
    state.add_argument("--minutes", type=positive_int, default=argparse.SUPPRESS,
                       help="waiting / pending 的兜底时限（分钟），默认 waiting 30、pending 60")
    add_text(state, "note")
    for action in ("pause", "resume", "clear"):
        add_leaf(subcommands, registry, f"goal {action}", "房主暂停、恢复或结束 Goal", True)
    update = add_leaf(subcommands, registry, "goal update", "房主修改 Goal 的目标或预算（0 表示不限）", True)
    add_text(update, "objective")
    for parser in (start, update):
        for name in ("max-continues", "max-minutes"):
            parser.add_argument(f"--{name}", type=non_negative_int, default=argparse.SUPPRESS, help="房主可选预算，0 表示不限")
        parser.add_argument("--idle-seconds", type=positive_int, default=argparse.SUPPRESS,
                            help="房主可选：房间空闲多少秒后唤醒主持人（30–1800，默认 120）")


def mode_commands(subcommands, registry):
    """Whichever mode (goal or discussion) is open: read it, and let the host declare it complete."""
    add_leaf(subcommands, registry, "mode view", "读取房间当前的模式（goal / discussion / 无）、状态和宣告完成所需的 revision", True)
    done = add_leaf(subcommands, registry, "mode done",
                    "主持人对照实际结果核验后宣告当前模式完成：Goal 结束为完成，讨论收束；先 mode view 取 revision", True)
    done.add_argument("--revision", required=True, help="mode view 返回的 revision；状态变化后须重新读取")
    add_text(done, "note")


def execution_commands(subcommands, registry):
    """Read an execution or report its failure through its durable identifier."""
    for action in ("view", "fail"):
        parser = add_leaf(subcommands, registry, f"execution {action}", "读取执行或报告本次执行失败", True)
        parser.add_argument("id", type=positive_int, nargs="?", help="执行编号；省略时用凭据绑定的执行")
        if action == "fail":
            parser.add_argument("--reason", required=True)


def member_commands(subcommands, registry):
    """Let a manual member announce itself; the CLI attaches the hosting session on its own."""
    add_leaf(subcommands, registry, "member register", "手动接入成员用自己的凭据向房间注册；会话 ID 由本程序自动附带，无需填写", True)
    capability = add_leaf(subcommands, registry, "member review-capability", "房主读取一个成员的能力事实和 revision；本机服务提交前先读", True)
    capability.add_argument("id", type=positive_int)


def review_commands(subcommands, registry):
    """Inspect the local service's read-only reviewer facts."""
    add_leaf(subcommands, registry, "review roster", "房主或主持人读取可核验的只读评审候选；此读取不派发任务", True)
    ready = add_leaf(subcommands, registry, "review ready", "先读取本批完整交付、评审资格、额度与 revision", True)
    ready.add_argument("--batch", type=positive_int, required=True)
    advance = add_leaf(subcommands, registry, "review advance", "先读 review ready，再带 revision 只推进既定评审并处理对应交接", True)
    advance.add_argument("--batch", type=positive_int, required=True)
    advance.add_argument("--revision", required=True)
    advance.add_argument("--submission-id", type=submission_id, help="推进唯一编号；省略时按命令与内容自动生成，同样内容重试得到同一编号")


def sequence_commands(subcommands, registry):
    """Read a host's one-after-another relay and run a loop's next pass from its checkpoint."""
    view = add_leaf(subcommands, registry, "sequence view", "房主或主持人读取依次接力的顺序、当前圈与本圈各棒原文；此读取不派发任务", True)
    view.add_argument("id", type=positive_int, help="依次接力编号（任务文件 requests[].sequence.id）")
    advance = add_leaf(subcommands, registry, "sequence continue", "主持人在检查点让接力继续：循环检查点再来一圈（加 --proceed 往下一棒），普通检查点往下一棒；只结束这条检查点交接，不继续则直接回答即结束接力", True)
    advance.add_argument("--request", type=positive_int, required=True, help="检查点交接请求编号（purpose=handoff 且 sequence.phase 为 checkpoint 或 gate）")
    advance.add_argument("--proceed", action="store_true", help="循环检查点不再来一圈，往下一棒走；最后一棒之后没有下一棒")


def build_parser(prog="discuss"):
    """Build help and schema from the same command definitions."""
    parser = Parser(prog=prog, description="AI CoDiscuss CLI：通过 HTTP 操作现有讨论网站。",
                    allow_abbrev=False, epilog="站点、房间、操作者与执行编号省略时取自凭据文件；提交编号省略时按内容生成；不保存当前房间；只在连接被拒绝时于 10 秒内自动重试，其他写入失败不重试。")
    add_common(parser)
    parser.add_argument("--version", action="version", version=f"{prog} {VERSION}")
    subcommands = parser.add_subparsers(dest="resource", required=True)
    registry = {}
    for name, register in (("room", room_commands), ("message", message_commands),
                           ("attachment", attachment_commands),
                           ("turn", turn_commands), ("state", state_commands),
                           ("run", run_commands), ("goal", goal_commands), ("mode", mode_commands), ("execution", execution_commands), ("member", member_commands), ("review", review_commands),
                           ("sequence", sequence_commands)):
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


def load_access(args):
    """Read an explicit file, a process-bound file, or inline credentials, in that order."""
    path = getattr(args, "access_file", None) or os.getenv("DISCUSS_ACCESS_FILE", "").strip()
    if path:
        return read_object(path)
    text = os.getenv("DISCUSS_ACCESS", "").strip()
    if not text:
        return {}
    try:
        value = json.loads(text)
    except ValueError as error:
        raise CliError(f"DISCUSS_ACCESS 不是有效 JSON: {error}") from error
    if not isinstance(value, dict):
        raise CliError("DISCUSS_ACCESS 必须是 JSON 对象")
    return value


def text_field(args, field):
    """Read one literal or file-backed field without altering its content."""
    values = vars(args)
    path = values.get(f"{field}_file")
    return read_input(path) if path is not None else values.get(field)


def split_summary_header(text):
    """Take a leading `---` / `summary: …` / `---` block off a body file, so one draft carries both fields.

    Returns `(summary, body)`; `summary` is None when the text does not open with exactly that block.
    """
    lines = text.splitlines(keepends=True)
    if len(lines) < 3 or lines[0].strip() != "---" or not lines[1].startswith("summary:") or lines[2].strip() != "---":
        return None, text
    return lines[1][len("summary:"):].strip(), "".join(lines[3:]).lstrip("\r\n")


def message_text_and_summary(args):
    """Read body and summary; a body file may hold the summary in its header instead of `--summary(-file)`."""
    body = text_field(args, "body") or ""
    summary = text_field(args, "summary")
    if getattr(args, "body_file", None) is not None:
        header, rest = split_summary_header(body)
        if header is not None:
            if summary is not None:
                raise CliError("正文文件头已带 summary，不能再用 --summary / --summary-file")
            body, summary = rest, header
    return body, summary


def require_actor(args):
    """Use the declared operator, or the member a task credential is bound to."""
    actor = getattr(args, "actor", None) or load_access(args).get("member")
    if not actor:
        raise CliError("写入须用 --as 指定操作者，或使用绑定成员的凭据；该字段声明操作者，不提供身份认证")
    return actor


def bound_execution(args):
    """Return the execution a task credential is bound to, if any."""
    value = load_access(args).get("execution_id")
    if value is None:
        return None
    try:
        return positive_int(str(value))
    except argparse.ArgumentTypeError as error:
        raise CliError("凭据文件中的 execution_id 无效") from error


def bind_room(args):
    """Fill an omitted room from the credential; a credential for another room is still rejected before sending."""
    if hasattr(args, "room") and args.room is None:
        args.room = load_access(args).get("room") or None
        if not args.room:
            raise CliError("请指定房间 ID，或使用绑定了房间的凭据（--access-file / DISCUSS_ACCESS_FILE）")


def topic_payload(args):
    """Collect only supplied topic fields; expert configuration is a full map."""
    payload = {}
    limits = {key: getattr(args, key) for key in ("max_rounds", "max_minutes", "execution_minutes") if hasattr(args, key)}
    if limits:
        payload["limits"] = limits
    for field in ("title", "goal", "user_request", "background", "boundaries", "focus"):
        value = text_field(args, field)
        if value is not None:
            payload[field] = value
    if hasattr(args, "host"):
        payload["host"] = args.host
    if hasattr(args, "experts_file"):
        experts = read_object(args.experts_file)
        if any(not INSTANCE_PATTERN.fullmatch(name) or mode != "cli" for name, mode in experts.items()):
            raise CliError("专家映射的名称必须是有效 AI，模式必须是 cli")
        payload["experts"] = experts
    return payload


def read_context_params(args):
    """Select an explicit manual request or the execution bound to this access file."""
    request_id = getattr(args, "request", None)
    execution_value = load_access(args).get("execution_id")
    if request_id is not None and execution_value is not None:
        raise CliError("读取时 --request 不能与凭据文件中的 execution_id 同用")
    if request_id is not None:
        return {"request_id": request_id}
    if execution_value is None:
        return {}
    try:
        execution_id = positive_int(str(execution_value))
    except argparse.ArgumentTypeError as error:
        raise CliError("凭据文件中的 execution_id 无效") from error
    return {"execution_id": execution_id}


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
        if args.done:
            return RequestPlan(base + "/limits", "POST", {"actor": require_actor(args), "action": "done",
                                                          **({"conclusion": args.conclusion} if args.conclusion else {})}, "overview")
        return RequestPlan(base + "/limits", "POST", {"actor": require_actor(args), "action": "check"}, "overview") if args.check else RequestPlan(base + "/limits")
    if args.action == "update":
        payload = topic_payload(args)
        if not payload:
            raise CliError("room update 至少需要一个话题字段")
        payload["actor"] = require_actor(args)
        return RequestPlan(base + "/topic", "POST", payload, "overview")
    if args.action == "conclusion":
        return RequestPlan(base + "/conclusion")
    if args.action == "protocol":
        return RequestPlan(f"/r/{args.room}/protocol")
    if args.action == "events":
        params = {"after": args.after, "before": args.before}
        return RequestPlan(base + "/events", params={key: value for key, value in params.items() if value})
    return RequestPlan(base, view="brief" if args.action == "brief" else "overview", params=read_context_params(args))


def plan_message(args):
    """Preserve operator, original author, message role, and replay identifier."""
    base = f"/api/rooms/{args.room}/messages"
    if args.action == "group-plan":
        return RequestPlan(f"/api/rooms/{args.room}/recommendations/{args.id}")
    if args.action == "view":
        return RequestPlan(f"{base}/{args.id}", params=read_context_params(args))
    if args.action == "list":
        params = {"page": args.page, "q": args.query, "author": args.author, "mention": args.mention,
                  "after": args.after, "kind": args.kind, "submission_id": args.submission_id,
                  **read_context_params(args)}
        return RequestPlan(base, params={key: value for key, value in params.items() if value is not None}, view="message_list")
    actor = require_actor(args)
    if args.proactive and (args.execution or args.request or args.kind != "chat"):
        raise CliError("--proactive 只用于 chat 消息，不能与 --execution / --request 同用")
    if not args.execution and not args.request and not args.proactive:
        args.execution = bound_execution(args)
    if (args.to or args.handoff) and args.kind != "chat":
        raise CliError("--to / --handoff 仅用于 chat 消息")
    if args.kind == "moderation" and not (args.execution or args.request):
        raise CliError("主持说明须关联本次 --execution 或有效 --request")
    if args.execution and args.request:
        raise CliError("--execution 用于接入程序交付的执行，--request 用于手动接入成员，二者不能同用")
    text, summary = message_text_and_summary(args)
    payload = {"author": actor, "submitted_by": actor, "source": "cli",
               "kind": args.kind, "text": text, "submission_id": args.submission_id}
    if len(args.attachment) > MAX_MESSAGE_ATTACHMENTS or len(set(args.attachment)) != len(args.attachment):
        raise CliError("每条消息最多 10 个附件，不能重复")
    if args.attachment:
        payload["attachment_ids"] = args.attachment
    if (not payload["text"].strip() and not args.attachment) or len(payload["text"].strip()) > MAX_TEXT_LENGTH:
        raise CliError(f"发言需包含正文或附件，正文最多 {MAX_TEXT_LENGTH} 个 Unicode 字符；不会自动截断或分段")
    if summary is not None:
        if len(summary.strip()) > MAX_SUMMARY_LENGTH:
            raise CliError(f"回答摘要最多 {MAX_SUMMARY_LENGTH} 个 Unicode 字符；不会自动截断")
        payload["summary"] = summary
    if args.execution:
        payload["execution_id"] = args.execution
    if args.request:
        payload["request_ids"] = list(dict.fromkeys(args.request))
    if args.to:
        payload["to"] = list(dict.fromkeys(args.to))
    if args.handoff:
        payload["handoff"] = True
    if args.continue_reason is not None:
        payload["continue"] = args.continue_reason
    if args.proactive:
        payload["proactive"] = True
    if args.no_handoff:
        payload["no_handoff"] = True
    if args.need_rounds is not None or args.rounds_reason is not None:
        payload["need_rounds"] = args.need_rounds
        payload["rounds_reason"] = args.rounds_reason
    if args.loop and not args.sequential:
        raise CliError("--loop 须与 --sequential 一起使用")
    if args.detach:
        if not args.to:
            raise CliError("--detach 须与 --to 一起使用")
        payload["detach"] = args.detach
    joined = getattr(args, "joined_steps", [])
    if joined and not args.sequential:
        raise CliError("--with 须与 --sequential 一起使用")
    if args.sequential:
        if len(args.to) < 2:
            raise CliError("--sequential 须用 --to 按顺序点名至少两位成员")
        payload["sequential"] = True
        if joined:
            payload["parallel"] = parallel_groups(args.to, joined)
    if args.loop:
        payload["loop"] = True
    gates = [{"after": name} for name in args.checkpoint] + args.repeat + args.wait_user
    if gates:
        if not args.sequential:
            raise CliError("--checkpoint、--repeat 与 --wait-user 须与 --sequential 一起使用")
        payload["gates"] = gates
    for field in ("next_review", "review_scope", "review_roster"):
        if getattr(args, field, None) is not None:
            payload[field] = getattr(args, field)
    if args.reply_to:
        payload["reply_to"] = args.reply_to
    # A hosting Claude Code or Codex session exposes its own ID; the room records it so the local service can take the member over.
    for variable, client in SESSION_VARIABLES:
        session_id = os.getenv(variable, "").strip()
        if session_id:
            payload["session_id"] = session_id
            payload["session_client"] = client
            break
    return RequestPlan(base, "POST", payload, "message_receipt")


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
    if args.action == "list":
        params = {"page": args.page}
        if args.submission_id:
            params["submission_id"] = args.submission_id
        return RequestPlan(base + "/turns", params=params)
    if args.action == "roster":
        return RequestPlan(base + "/turns/roster")
    if args.action == "order":
        return RequestPlan(base + "/speaking-order")
    if args.action == "reorder":
        return RequestPlan(base + "/speaking-order", "POST", {"revision": args.revision, "order": args.member})
    if args.action == "create":
        return RequestPlan(base + "/turns", "POST", turn_payload(args))
    if args.action == "continue":
        return RequestPlan(base + "/turns/continue", "POST", {"actor": require_actor(args), "revision": args.roster})
    if args.action == "ask":
        return RequestPlan(base + "/turns/ask", "POST", {"actor": require_actor(args), "revision": args.roster,
                           "request_id": args.request, "expert": args.expert, "submission_id": args.submission_id})
    path = f"{base}/turns/{args.id}"
    if args.action == "cancel":
        status = "cancelled"
        return RequestPlan(path, "POST", {"actor": require_actor(args), "status": status})
    return RequestPlan(path)


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
        return {**payload, "turns": turns, "roster": args.roster}
    if not args.expert or question is None:
        raise CliError("需要 --expert 与 --question/--question-file，或改用 --plan-file")
    return {**payload, "expert": args.expert, "question": question, "roster": args.roster}


def plan_state(args):
    """Keep a host summary's cutoff explicit instead of assuming latest means read."""
    base = f"/api/rooms/{args.room}"
    if args.action == "decision":
        return RequestPlan(f"{base}/scheduler-decisions/{args.id}")
    if args.action == "view":
        return RequestPlan(base, view="state", params=read_context_params(args))
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
    """Build one revision-bound discussion-session lifecycle request."""
    path = f"/api/rooms/{args.room}/discussion"
    if args.action == "view":
        return RequestPlan(path)
    body = {"action": "end" if args.action == "stop" else args.action}
    if args.action == "start" and bool(args.request) == bool(args.revision):
        raise CliError("run start 须二选一：房主用 --revision，主持人用 --request（discuss_start 请求编号）")
    if args.revision:
        body["revision"] = args.revision
    if args.action == "start" and args.request:
        body["request_id"] = args.request
    if args.action == "start":
        goal = text_field(args, "goal")
        if goal is not None:
            body["goal"] = goal
        limits = {key: getattr(args, key) for key in ("max_rounds", "max_minutes", "execution_minutes")
                  if hasattr(args, key)}
        if limits:
            body["limits"] = limits
        if args.submission_id:
            body["submission_id"] = args.submission_id
    return RequestPlan(path, "POST", body)


def plan_goal(args):
    """Build one goal request; budgets and the objective are sent only when given."""
    path = f"/api/rooms/{args.room}/goal"
    if args.action == "view":
        return RequestPlan(path)
    body = {"action": args.action}
    objective = text_field(args, "objective") if args.action in ("start", "update") else None
    if objective is not None:
        body["objective"] = objective
    note = text_field(args, "note") if args.action in ("done", "block", "state") else None
    if note is not None:
        body["note"] = note
    if args.action == "state":
        body["state"] = args.state
    for key in ("max_continues", "max_minutes", "idle_seconds", "minutes"):
        if hasattr(args, key):
            body[key] = getattr(args, key)
    if args.action == "start":
        if bool(args.request) == bool(args.revision):
            raise CliError("goal start 须二选一：主持人用 --request（goal_start 请求编号），房主用 --revision")
        if args.request:
            body["request_id"] = args.request
    if getattr(args, "revision", None):
        body["revision"] = args.revision
    return RequestPlan(path, "POST", body)


def plan_mode(args):
    """Read the open mode, or complete it with the revision read from mode view."""
    path = f"/api/rooms/{args.room}/mode"
    if args.action == "view":
        return RequestPlan(path)
    body = {"action": "done", "revision": args.revision}
    note = text_field(args, "note")
    if note is not None:
        body["note"] = note
    return RequestPlan(path, "POST", body)


def plan_execution(args):
    """Read or fail one durable member execution."""
    execution_id = args.id or bound_execution(args)
    if not execution_id:
        raise CliError("请指定执行编号，或使用绑定了执行的凭据")
    path = f"/api/rooms/{args.room}/executions/{execution_id}"
    if args.action == "view":
        return RequestPlan(path)
    return RequestPlan(path, "POST", {"action": "fail", "reason": args.reason})


def plan_member(args):
    """Register with the credential file; the token itself decides which member this is."""
    if args.action == "review-capability":
        return RequestPlan(f"/api/rooms/{args.room}/members/{args.id}/review-capability")
    if not load_access(args):
        raise CliError("注册须使用成员自己的凭据文件（--access-file 或 DISCUSS_ACCESS_FILE）")
    return RequestPlan(f"/api/rooms/{args.room}/register", "POST", {})


def plan_review(args):
    """Read eligible reviewers without creating a request or changing permissions."""
    if args.action == "roster":
        return RequestPlan(f"/api/rooms/{args.room}/reviews/roster")
    if args.action == "ready":
        return RequestPlan(f"/api/rooms/{args.room}/reviews/{args.batch}/ready")
    return RequestPlan(f"/api/rooms/{args.room}/reviews/advance", "POST", {
        "actor": require_actor(args), "batch_id": args.batch, "revision": args.revision, "submission_id": args.submission_id})


def plan_sequence(args):
    """Read a relay, or continue a loop bound to its one checkpoint request."""
    if args.action == "view":
        return RequestPlan(f"/api/rooms/{args.room}/sequences/{args.id}")
    return RequestPlan(f"/api/rooms/{args.room}/sequences/continue", "POST", {"actor": require_actor(args), "request_id": args.request,
                                                                               **({"proceed": True} if args.proceed else {})})


def build_plan(args):
    """Validate local input before constructing any network request."""
    stdin_count = sum(value == "-" for key, value in vars(args).items()
                      if key.endswith("_file") or key == "input")
    if stdin_count > 1:
        raise CliError("一次命令只能有一个字段从标准输入读取")
    handlers = {"room": plan_room, "message": plan_message, "turn": plan_turn,
                "attachment": plan_attachment,
                "state": plan_state, "api": plan_api,
                "run": plan_run, "goal": plan_goal, "mode": plan_mode, "execution": plan_execution, "member": plan_member, "review": plan_review, "sequence": plan_sequence}
    bind_room(args)
    plan = RequestPlan("/api/health") if args.resource == "health" else handlers[args.resource](args)
    fill_submission_id(args, plan)
    if getattr(args, "dry_run", False) and plan.method != "POST" and plan.download_file is None:
        raise CliError("--dry-run 仅用于写入命令；读取命令本身不会修改数据")
    if plan.body is not None and len(json.dumps(plan.body, ensure_ascii=False).encode("utf-8")) > MAX_BODY_BYTES:
        raise CliError(f"请求体超过服务端限制 {MAX_BODY_BYTES} 字节")
    return plan


def resolve_site(args):
    """Resolve the flag, then the environment, then the site the access file is bound to; never a built-in default."""
    site = getattr(args, "site", None) or os.getenv("DISCUSS_URL", "")
    if not site:
        # The credential's own site is the only place it is ever sent back to.
        site = str(load_access(args).get("site", ""))
    parsed = urlsplit(site)
    if (parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username
            or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        raise CliError("请用 --site、DISCUSS_URL 或凭据（--access-file / DISCUSS_ACCESS_FILE / DISCUSS_ACCESS）指定 http(s)://主机[:端口]，不带路径、凭据或查询")
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


def connection_refused(error):
    """Whether the request failed before anything reached the site."""
    cause = error.reason if isinstance(error, URLError) else error
    return isinstance(cause, ConnectionRefusedError)


ENTRY_KEY_VARIABLE = "DISCUSS_ENTRY_KEY_FILE"
ENTRY_KEY_PATTERN = re.compile(r"^[0-9a-f]{64}$")
ENTRY_NONCE_PATTERN = re.compile(r"^[0-9a-f]{32}$")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def entry_key():
    """This instance's key when entry protection is configured, '' when it is not; an unusable key stops the request."""
    path = os.getenv(ENTRY_KEY_VARIABLE)
    if not path:
        return ""
    try:
        key = json.loads(Path(path).read_text(encoding="utf-8")).get("key")
    except (OSError, ValueError, AttributeError):
        key = None
    if not isinstance(key, str) or not ENTRY_KEY_PATTERN.match(key):
        raise CliError("这个工作台开启了入口保护，但读不到它的密钥，请求没有发出", 3, outcome="unavailable")
    return key


def entry_proof(key, purpose, nonce):
    """HMAC-SHA256 of ``purpose|nonce`` under the hexadecimal key (backend/entry_guard.py)."""
    return hmac.new(bytes.fromhex(key), f"{purpose}|{nonce}".encode("ascii"), hashlib.sha256).hexdigest()


def open_protected(url, method, data, headers, timeout, key):
    """Send one request to a protected instance on a connection where the instance first proved its key.

    The connection never reopens by itself (``auto_open = 0``): a hello that announces closing, or a connection that
    drops after it, ends the attempt instead of sending the request on a new, unverified connection.
    """
    parts = urlsplit(url)
    connection = http.client.HTTPConnection(parts.hostname, parts.port or 80, timeout=timeout)
    connection.auto_open = 0
    connection.connect()
    nonce = secrets.token_hex(16)
    connection.request("GET", "/_instance/hello", headers={"X-CoDiscuss-Nonce": nonce})
    hello = connection.getresponse()
    hello.read()
    challenge = hello.getheader("X-CoDiscuss-Nonce", "")
    if (hello.status != 204 or hello.will_close or not ENTRY_NONCE_PATTERN.match(challenge)
            or not hmac.compare_digest(hello.getheader("X-CoDiscuss-Proof", ""), entry_proof(key, "instance", nonce))):
        connection.close()
        raise CliError("无法确认这是目标工作台，请求没有发出", 3, outcome="unavailable")
    path = parts.path + (f"?{parts.query}" if parts.query else "")
    connection.request(method, path, body=data, headers={**headers, "X-CoDiscuss-Entry": entry_proof(key, "entry", challenge)})
    response = connection.getresponse()
    if response.status >= 400:
        raise HTTPError(url, response.status, response.reason, response.headers, response)
    return response


def send_request(plan, url, timeout, headers=None):
    """Send once it is accepted, retrying only a refused connection, with TLS verification and bounded waiting."""
    data = request_data(plan)
    content_type = "application/octet-stream" if plan.upload_file is not None else "application/json"
    fields = {"Content-Type": content_type, "Accept": "*/*" if plan.download_file else "application/json, text/plain",
              "User-Agent": f"AI-CoDiscuss-CLI/{VERSION}", **(headers or {})}
    request = Request(url, data=data, method=plan.method, headers=fields)
    # A protected instance on this computer is reached only through the handshake; nothing falls back to a plain request.
    key = entry_key() if urlsplit(url).hostname in LOOPBACK_HOSTS else ""
    deadline = time.monotonic() + REFUSED_RETRY_SECONDS
    while True:
        try:
            if key:
                response = open_protected(url, plan.method, data, fields, timeout, key)
                with response:
                    return decode_response(response, plan)
            with build_opener(NoRedirect()).open(request, timeout=timeout) as response:
                return decode_response(response, plan)
        except HTTPError as error:
            with error:
                raise http_error(error, plan) from error
        except (URLError, OSError, HTTPException) as error:
            if connection_refused(error) and time.monotonic() < deadline:
                time.sleep(REFUSED_RETRY_INTERVAL)
                continue
            raise CliError(f"网络请求失败: {error}", 3,
                           outcome="unknown" if plan.method == "POST" else "unavailable") from error


def select_fields(value, names):
    """Project explicitly requested fields without expanding additional context."""
    return {name: value[name] for name in names if name in value}


def project_result(value, plan, site):
    """Keep summaries, briefing material, host state, and original text separate."""
    if plan.view == "room_list":
        return {"rooms": [select_fields(room, ROOM_LIST_FIELDS) for room in value["rooms"]]}
    if plan.view in ("overview", "brief", "state"):
        fields = {"overview": OVERVIEW_FIELDS, "brief": BRIEF_FIELDS,
                  "state": ("id", "state_text", "state_until", "host_brief", "answered_turns")}[plan.view]
        result = select_fields(value, fields)
        if plan.view == "overview":
            if isinstance(result.get("free"), dict):
                result["free"] = overview_free(result["free"])
            result["guidance"] = GUIDANCE.get(value["phase"], "按本次主持或专家职责，结合最新阶段、安排和必要原文决定下一步。")
            result["url"] = f"{site}/r/{value['id']}"
        return result
    if plan.view == "message_list":
        return fit_message_page(value)
    if plan.view == "message_receipt" and isinstance(value.get("message"), dict):
        message = value["message"]
        receipt = {**select_fields(message, RECEIPT_FIELDS), "text_chars": len(message.get("text") or ""),
                   "attachments": len(message.get("attachments") or [])}
        return {**{key: item for key, item in value.items() if key != "message"}, "message": receipt}
    return value


def overview_free(free):
    """Keep open requests and live or recent executions in brief; finished history stays behind execution view."""
    result = dict(free)
    if isinstance(free.get("requests"), list):
        result["requests"] = [item for item in free["requests"] if item.get("status") not in TERMINAL_STATUSES]
    executions = free.get("executions")
    if isinstance(executions, list):
        recent = len(executions) - RECENT_EXECUTIONS
        result["executions"] = [select_fields(item, EXECUTION_FIELDS) for index, item in enumerate(executions)
                                if index >= recent or item.get("status") not in TERMINAL_STATUSES]
    return result


def fit_message_page(page):
    """Stop a page at the output budget so no agent tool cuts it silently; the cursor resumes after the last shown."""
    messages, used = [], 0
    for message in page.get("messages", []):
        used += len(json.dumps(message, ensure_ascii=False, indent=2))
        if messages and used > LIST_OUTPUT_CHARS:
            break
        messages.append(message)
    if len(messages) == len(page.get("messages", [])):
        return page
    last = messages[-1]["id"]
    return {**page, "messages": messages, "next_after": last, "has_more": True,
            "notice": f"本次输出到上限，只列了 {len(messages)} 条；用 --after {last} 加同样的筛选续读"}


def command_schema(args, registry):
    """Describe available commands and fields from the live argparse registry."""
    name = " ".join(args.command)
    if not name:
        return {"version": VERSION, "commands": {key: item.description for key, item in registry.items()},
                "exit_codes": EXIT_CODES, "site": "--site > DISCUSS_URL > 凭据（--access-file / DISCUSS_ACCESS_FILE / DISCUSS_ACCESS）中的 site；无内置默认站点",
                "output": "默认 JSON；成功 stdout，错误 stderr；无交互提示；只在连接被拒绝时于 10 秒内自动重试"}
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
                                               "turn create", "turn cancel", "state set", "attachment upload", "review advance",
                                               "sequence continue"):
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


def save_access(path, value):
    """Persist private capabilities before sending requests, without printing their content."""
    target = Path(path)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=target.parent, delete=False) as stream:
        temporary = Path(stream.name)
        os.chmod(temporary, 0o600)
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    try:
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def prepare_creation_access(args, site, plan):
    """Create or reuse one explicit private credential bundle for a stable creation id."""
    if getattr(args, "operation", "") != "room create":
        return
    if not getattr(args, "access_file", None):
        raise CliError("建房须用 --access-file 指定私有凭据文件路径；首次自动生成，重试沿用同一文件")
    path = Path(args.access_file)
    payload = plan.body
    if path.exists() and not args.submission_id:
        # A retry that omits the ID continues the creation this credential file already recorded.
        payload["submission_id"] = read_object(path).get("submission_id") or payload["submission_id"]
    access = read_object(path) if path.exists() else {"site": site, "room": "", "token": secrets.token_urlsafe(48),
        "submission_id": payload.get("submission_id"), "members": {}}
    if access.get("site") != site or access.get("submission_id") != payload.get("submission_id"):
        raise CliError("建房凭据文件与本次站点或 submission_id 不符")
    experts = payload.setdefault("experts", {name: "cli" for name in PARTICIPANTS[1:]})
    members = []
    for name in experts:
        member = access["members"].setdefault(name, {"token": secrets.token_urlsafe(48)})
        members.append({"name": name, "token": member["token"], "access": "manual"})
    payload["members"] = members
    save_access(path, access)


def finish_creation_access(args, site, plan, value):
    """Save the confirmed room and separate member files; return paths without secrets."""
    if getattr(args, "operation", "") != "room create":
        return {}
    path = Path(args.access_file).resolve()
    access = read_object(path)
    access["room"] = value["id"]
    save_access(path, access)
    paths = {}
    for member in plan.body["members"]:
        member_path = path.with_name(f"{path.stem}.{member['name']}.json")
        save_access(member_path, {"site": site, "room": value["id"], "member": member["name"], "token": member["token"]})
        paths[member["name"]] = str(member_path)
    return {"owner_access_file": str(path), "member_access_files": paths}


def access_headers(args, site, path):
    """Load a room-scoped secret only for its exact site and room."""
    access = load_access(args)
    if not access:
        return {}
    expected = f"/api/rooms/{access.get('room', '')}"
    target = urlsplit(path).path
    creation = target == "/api/rooms" and bool(access.get("submission_id"))
    reading = f"/r/{access.get('room', '')}"
    if access.get("site", "").rstrip("/") != site or not (creation or target == expected or target.startswith(expected + "/") or target == reading or target.startswith(reading + "/")):
        raise CliError("凭据文件不属于本次站点和房间")
    token = access.get("token")
    if not isinstance(token, str) or not 32 <= len(token) <= 256:
        raise CliError("凭据文件中的 token 无效")
    headers = {"X-Discussion-Token": token}
    # A hosting Claude Code or Codex session reports itself on any call, so a manual member can be taken over before it first speaks.
    for variable, client in SESSION_VARIABLES:
        session_id = os.getenv(variable, "").strip()
        if session_id:
            headers.update({"X-Discussion-Session": session_id, "X-Discussion-Session-Client": client})
            break
    return headers


def preview_body(value):
    """Keep private capability material out of offline request previews."""
    if isinstance(value, dict):
        return {key: "[redacted]" if key in ("token", "execution_token", "control_hash", "token_hash") else preview_body(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [preview_body(item) for item in value]
    return value


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
        return {"ok": True, "data": {"method": plan.method, "url": url, "body": preview_body(plan.body),
                                   **({"file": plan.upload_file} if plan.upload_file else {}),
                                   **({"destination": plan.download_file} if plan.download_file else {})},
                "meta": {**meta, "dry_run": True, "validation": "仅本地参数；未验证房间、身份或服务端状态"}}
    try:
        prepare_creation_access(args, site, plan)
        # A member started outside the service's environment learns its instance's key file from the task's access file.
        key_file = load_access(args).get("entry_key_file")
        if isinstance(key_file, str) and key_file and not os.getenv(ENTRY_KEY_VARIABLE):
            os.environ[ENTRY_KEY_VARIABLE] = key_file
        headers = access_headers(args, site, plan.path)
        value = send_request(plan, url, timeout, headers) if headers else send_request(plan, url, timeout)
        result = project_result(value, plan, site)
        if getattr(args, "operation", "") == "room create":
            result.update(finish_creation_access(args, site, plan, value))
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
