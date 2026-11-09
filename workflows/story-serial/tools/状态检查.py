"""状态账检查：只读，不改任何文件。

用法（在任意目录运行，参数是作品文件夹，即含 状态/ 与 正文/ 的那一层）:
    python -X utf8 状态检查.py 作品/我的小说

依赖 PyYAML（pip install pyyaml）。

检查四项:
    1. 状态/ 下每个 YAML 能否解析；
    2. 账里用中文引号“”括起的引文，是否真的出现在现定稿正文里（不含 正文/旧稿_* 目录）；
    3. 线索.yaml 里“埋于”“最后一次动”的集号是否存在，按最新一集重算“停了几集”，与账上写的对比；
    4. 账里“见某某.yaml”的指向，文件是否存在。
"""

import logging
import re
import sys
from pathlib import Path

import yaml

BOOK_DIR = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
STATE_DIR = BOOK_DIR / "状态"
TEXT_DIR = BOOK_DIR / "正文"
MIN_QUOTE_LEN = 6  # 少于这个字数的引号内容多半是称呼、单字记号，不当引文查
EPISODE_PATTERN = re.compile(r"第\s?(\d{1,2})\s?集")
QUOTE_PATTERN = re.compile(r"“([^“”]+)”")
REFERENCE_PATTERN = re.compile(r"([一-龥]+\.yaml)")
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


def parse_episode(value):
    """从“第04集”一类文字里取出集号，取不到返回 None。"""
    match = EPISODE_PATTERN.search(value or "")
    return int(match.group(1)) if match else None


def check_threads(data, latest):
    """查线索的集号和“停了几集”，返回问题列表。"""
    problems = []
    threads = data.get("线索.yaml", {}).get("线索", [])
    for item in threads:
        name = item.get("线", "（无名）")[:24]
        for field in ("埋于", "最后一次动"):
            number = parse_episode(item.get(field))
            if number is None or number > latest:
                problems.append(f"{name}：{field}“{item.get(field)}”不是已写出的集号")
        last = parse_episode(item.get("最后一次动"))
        recorded = re.search(r"停\s?(\d+)\s?集", item.get("停", ""))
        if last and recorded and int(recorded.group(1)) != latest - last:
            problems.append(f"{name}：账上写停 {recorded.group(1)} 集，按第 {latest} 集算应为 {latest - last} 集")
    return problems


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


def main():
    """运行全部检查，有问题时返回 1。"""
    if not STATE_DIR.is_dir() or not TEXT_DIR.is_dir():
        log.info("%s 下没有 状态/ 和 正文/：参数须是作品文件夹", BOOK_DIR)
        return 2
    episodes = load_episodes()
    latest = max(episodes) if episodes else 0
    data, parse_errors = load_state()
    log.info("正文：第 01—%02d 集；状态文件：%s", latest, "、".join(data))
    report("解析", parse_errors)
    sections = [
        ("引文不在现正文里", check_quotes(data, episodes)),
        ("线索集号与停了几集", check_threads(data, latest)),
        ("文件指向", check_references(data)),
    ]
    for title, problems in sections:
        report(title, problems)
    return 1 if parse_errors or any(problems for _, problems in sections) else 0


if __name__ == "__main__":
    sys.exit(main())
