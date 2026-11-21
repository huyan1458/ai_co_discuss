"""状态账检查：只读，不改任何文件。

用法（在任意目录运行，参数是作品文件夹，即含 状态/ 与 正文/ 的那一层）:
    python -X utf8 状态检查.py 作品/我的小说

依赖 PyYAML（pip install pyyaml）。

“最新一集”按 分集记录.yaml 记到的最后一集算：正文里比它新的集是还没记账的稿子，
只在开头提示“待记账”，不参与下面的计算。

检查五项:
    1. 状态/ 下每个 YAML 能否解析；
    2. 分集记录与正文是否逐集对应（记了账却没有正文、中间漏记的集）；
    3. 账里用中文引号“”括起的引文，是否真的出现在现定稿正文里（不含 正文/旧稿_* 目录）；
    4. 线索.yaml 里“埋于”“最后一次动”的集号是否存在（“停了几集”由脚本计算，账上不必写）；
    5. 账里“见某某.yaml”的指向，文件是否存在。

最后另印一节“体检”，对照文档标准给出整理信号，只提示，不算检查失败：
    现状文件（主角、物资、据点、人物）超过 80 字的条目；各账本“待确认”一类字样的处数；
    文件头注释行数；分集记录里超过 15 行的集；线索久悬（停 5 集及以上）的条目。

退出码：0 全部通过（体检提示不影响）；1 有问题；2 没有可检查的内容（缺文件夹、没有账本或没有正文）。
"""

import logging
import re
import sys
from pathlib import Path

import yaml

BOOK_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
STATE_DIR = BOOK_DIR / "状态"
TEXT_DIR = BOOK_DIR / "正文"
EPISODE_LOG_FILE = "分集记录.yaml"
EXIT_NOTHING_TO_CHECK = 2
MIN_QUOTE_LEN = 6  # 少于这个字数的引号内容多半是称呼、单字记号，不当引文查
EPISODE_PATTERN = re.compile(r"第\s?(\d{1,3})\s?集")
QUOTE_PATTERN = re.compile(r"“([^“”]+)”")
REFERENCE_PATTERN = re.compile(r"([一-龥]+\.yaml)")
CURRENT_FILES = ("主角.yaml", "物资.yaml", "据点.yaml", "人物.yaml")
MAX_ENTRY_CHARS = 80  # 现状条目字数上限，见文档标准
MAX_EPISODE_LINES = 15  # 分集记录每集行数上限
MAX_HEADER_LINES = 5  # 文件头注释行数上限
STALE_EPISODES = 5  # 线索停这么多集以上列为久悬
PENDING_PATTERN = re.compile(r"待确认|待定|待核|未报")
STRIP_PATTERN = re.compile(r"[\s　*【】，。、；：！？,.;:!?‘’“”\"'（）()—…·]")

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stdout)
log = logging.getLogger("状态检查")


def normalize(text):
    """去掉空白、标点和排版符号，只比文字，避免逗号句号差异误报。"""
    return STRIP_PATTERN.sub("", text)


def load_episodes():
    """读现定稿正文，返回 {集号: 规范化全文}。"""
    episodes = {}
    for path in sorted(TEXT_DIR.glob("第*集_*.md")):
        match = EPISODE_PATTERN.search(path.name)
        if match:
            episodes[int(match.group(1))] = normalize(path.read_text(encoding="utf-8"))
    return episodes


def load_state():
    """解析状态文件夹，返回 ({文件名: 数据}, [解析错误])。"""
    data, errors = {}, []
    for path in sorted(STATE_DIR.glob("*.yaml")):
        try:
            data[path.name] = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as exc:
            errors.append(f"{path.name}: {exc}".replace("\n", " "))
    return data, errors


def walk_strings(node, trail=""):
    """遍历嵌套结构里的每个字符串，产出 (路径, 文本)。"""
    if isinstance(node, dict):
        for key, value in node.items():
            yield from walk_strings(value, f"{trail}/{key}")
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield from walk_strings(value, f"{trail}[{index}]")
    elif isinstance(node, str):
        yield trail, node


def parse_episode(value):
    """从“第04集”一类文字里取出集号，取不到返回 None。"""
    match = EPISODE_PATTERN.search(str(value or ""))
    return int(match.group(1)) if match else None


def recorded_episodes(data):
    """返回分集记录里记过账的集号集合。"""
    content = data.get(EPISODE_LOG_FILE) or {}
    entries = content.get("分集记录", []) if isinstance(content, dict) else []
    numbers = set()
    for entry in entries or []:
        number = parse_episode(entry.get("集数")) if isinstance(entry, dict) else None
        if number is not None:
            numbers.add(number)
    return numbers


def check_coverage(episodes, recorded):
    """查分集记录与正文是否逐集对应，返回问题列表。"""
    problems = [f"分集记录有第 {number:02d} 集，正文里没有这一集" for number in sorted(recorded - set(episodes))]
    latest = max(recorded)
    problems += [
        f"第 {number:02d} 集有正文，分集记录漏记（账已记到第 {latest:02d} 集）"
        for number in sorted(set(episodes) - recorded)
        if number < latest
    ]
    return problems


def check_quotes(data, episodes):
    """查引文是否出现在现正文里，返回问题列表。"""
    all_text = "".join(episodes.values())
    problems = []
    for file_name, content in data.items():
        for trail, text in walk_strings(content):
            for quote in QUOTE_PATTERN.findall(text):
                segments = [normalize(part) for part in re.split(r"……|…|——", quote)]
                segments = [part for part in segments if len(part) >= MIN_QUOTE_LEN]
                missing = [part for part in segments if part not in all_text]
                if missing:
                    problems.append(f"{file_name}{trail}：“{quote[:40]}”")
    return problems


def check_threads(data, episodes, latest):
    """查线索的集号和“停了几集”，返回问题列表。"""
    problems = []
    content = data.get("线索.yaml") or {}
    threads = content.get("线索", []) if isinstance(content, dict) else []
    for item in threads or []:
        if not isinstance(item, dict):
            problems.append(f"线索条目不是“键: 值”结构：{str(item)[:24]}")
            continue
        name = str(item.get("线", "（无名）"))[:24]
        for field in ("埋于", "最后一次动"):
            number = parse_episode(item.get(field))
            if number is None or number not in episodes or number > latest:
                problems.append(f"{name}：{field}“{item.get(field)}”不是已记账的集号")
    return problems


def header_lines(path):
    """数文件开头连续的注释行。"""
    count = 0
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        if not line.lstrip().startswith("#"):
            break
        count += 1
    return count


def thread_items(data):
    """返回线索账里的条目（只取字典）。"""
    content = data.get("线索.yaml") or {}
    items = content.get("线索", []) if isinstance(content, dict) else []
    return [item for item in items or [] if isinstance(item, dict)]


def episode_lines(entry):
    """数一集分集记录里的变化行：只数值为列表的那几栏里的元素。"""
    return sum(len(value) for value in entry.values() if isinstance(value, list))


def health_report(data, latest):
    """对照文档标准列出整理信号，只提示，返回提示行列表（每类汇总一行，未回收的久悬线逐条列）。"""
    hints = []
    long_counts = []
    for name in CURRENT_FILES:
        count = sum(1 for _, text in walk_strings(data.get(name) or {}) if len(text) > MAX_ENTRY_CHARS)
        if count:
            long_counts.append(f"{name} {count}")
    if long_counts:
        hints.append(f"现状条目超过 {MAX_ENTRY_CHARS} 字：" + "、".join(long_counts))
    pending_counts = []
    for name, content in data.items():
        count = sum(len(PENDING_PATTERN.findall(text)) for _, text in walk_strings(content))
        if count:
            pending_counts.append((name, count))
    if pending_counts:
        total = sum(count for _, count in pending_counts)
        hints.append(f"“待确认”一类字样合计 {total} 处：" + "、".join(f"{name} {count}" for name, count in pending_counts))
    long_headers = [f"{name} {lines} 行" for name in data if (lines := header_lines(STATE_DIR / name)) > MAX_HEADER_LINES]
    if long_headers:
        hints.append(f"文件头注释超过 {MAX_HEADER_LINES} 行：" + "、".join(long_headers))
    log_content = data.get(EPISODE_LOG_FILE) or {}
    entries = log_content.get("分集记录", []) if isinstance(log_content, dict) else []
    long_episodes = [str(entry.get("集数")) for entry in entries or [] if isinstance(entry, dict) and episode_lines(entry) > MAX_EPISODE_LINES]
    if long_episodes:
        hints.append(f"分集记录超过 {MAX_EPISODE_LINES} 行的集 {len(long_episodes)} 个：" + "、".join(long_episodes))
    threads = thread_items(data)
    closed = [item for item in threads if "已回收" in str(item.get("现状", ""))]
    if closed:
        hints.append(f"线索.yaml：已回收仍在册 {len(closed)} 条")
    for item in threads:
        if item in closed:
            continue
        last = parse_episode(item.get("最后一次动"))
        if last and latest - last >= STALE_EPISODES:
            hints.append(f"久悬：{str(item.get('线', '（无名）'))[:24]} 停了 {latest - last} 集")
    return hints


def check_references(data):
    """查“见某某.yaml”指向的文件是否存在，返回问题列表。"""
    names = {path.name for path in STATE_DIR.glob("*.yaml")}
    problems = set()
    for file_name, content in data.items():
        for trail, text in walk_strings(content):
            for ref in REFERENCE_PATTERN.findall(text):
                if not any(ref.endswith(name) for name in names):  # 引文前常连着“见”字
                    problems.add(f"{file_name}{trail}：指向不存在的 {ref}")
    return sorted(problems)


def report(title, problems):
    """打印一节检查结果。"""
    log.info("\n== %s：%s ==", title, f"{len(problems)} 处" if problems else "通过")
    for line in problems:
        log.info("  - %s", line)


def nothing_to_check(episodes, data, parse_errors, recorded):
    """没有可检查的内容时返回原因，否则返回空字符串。"""
    if not STATE_DIR.is_dir() or not TEXT_DIR.is_dir():
        return "没有 状态/ 和 正文/：参数须是作品文件夹"
    if not episodes:
        return "正文/ 里没有“第NN集_标题.md”"
    if not data and not parse_errors:
        return "状态/ 里没有账本"
    if EPISODE_LOG_FILE in data and not recorded:
        return f"{EPISODE_LOG_FILE} 里还没有记过任何一集"
    return ""


def main():
    """运行全部检查：有问题返回 1，没有可检查的内容返回 2。"""
    episodes = load_episodes() if TEXT_DIR.is_dir() else {}
    data, parse_errors = load_state() if STATE_DIR.is_dir() else ({}, [])
    recorded = recorded_episodes(data)
    reason = nothing_to_check(episodes, data, parse_errors, recorded)
    if reason:
        log.info("%s：%s。尚无可检查内容，不算通过", BOOK_DIR, reason)
        return EXIT_NOTHING_TO_CHECK
    latest = max(recorded) if recorded else max(episodes)
    pending = sorted(number for number in episodes if number > latest)
    log.info("账记到第 %02d 集；状态文件：%s", latest, "、".join(data))
    if pending:
        log.info("待记账（不参与下面的计算）：%s", "、".join(f"第 {number:02d} 集" for number in pending))
    checked = {number: text for number, text in episodes.items() if number <= latest}
    report("解析", parse_errors)
    sections = [
        ("分集记录与正文对应", check_coverage(episodes, recorded) if recorded else []),
        ("引文不在现正文里", check_quotes(data, checked)),
        ("线索集号", check_threads(data, checked, latest)),
        ("文件指向", check_references(data)),
    ]
    for title, problems in sections:
        report(title, problems)
    hints = health_report(data, latest)
    log.info("\n== 体检（只提示，不算失败）：%s ==", f"{len(hints)} 条" if hints else "无")
    for line in hints:
        log.info("  - %s", line)
    return 1 if parse_errors or any(problems for _, problems in sections) else 0


if __name__ == "__main__":
    sys.exit(main())
