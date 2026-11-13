"""朱雀 AIGC 文本检测的命令行工具：查分、定位拉高分数的段落和句子、统计用量。

只依赖 Python 标准库。密钥读环境变量 ZHUQUE_API_KEY，没有则读 ~/.codiscuss/aigc-reduce/key.txt。
每次调用的结果按文本内容缓存在 ~/.codiscuss/aigc-reduce/cache.jsonl，同一段文字不重复扣额度。
"""
import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.request

API_URL = "https://ai-gateway.edgeone.link/v1/providers/zhuque-text/classify"
HOME_DIR = os.path.join(os.path.expanduser("~"), ".codiscuss", "aigc-reduce")
KEY_FILE = os.path.join(HOME_DIR, "key.txt")
CACHE_FILE = os.path.join(HOME_DIR, "cache.jsonl")
HUMAN_MAX = 0.5          # 低于此值判为人工特征
AI_MIN = 0.99            # 不低于此值判为 AI 特征
CHUNK_CHARS = 300        # 定位时每块的目标字数；更短的文本分数不稳
DRIVER_DROP = 0.3        # 去掉后分数下降超过此值，算作拉高分数的段落或句子
MIN_REST_CHARS = 120     # 去掉一段后剩余文字少于此数，结果不可信，不测
RETRY_TIMES = 5
TIMEOUT_SECONDS = 120


def _read_key():
    key = os.environ.get("ZHUQUE_API_KEY")
    if key:
        return key.strip()
    if os.path.exists(KEY_FILE):
        return open(KEY_FILE, encoding="utf-8").read().strip()
    sys.exit(f"缺少密钥：设置环境变量 ZHUQUE_API_KEY，或把密钥写进 {KEY_FILE}")


def _load_cache():
    cache = {}
    if os.path.exists(CACHE_FILE):
        for line in open(CACHE_FILE, encoding="utf-8"):
            record = json.loads(line)
            cache[record["key"]] = record
    return cache


_CACHE = None


def detect(text, merge=True):
    """检测一段文字，返回接口的完整响应。

    Args:
        text: 待检测文字。
        merge: True 时相邻同档的窗口合并成片段；False 时按约 270 字的窗口逐个给分。

    Returns:
        接口响应 dict，含 softmax_confidence、labels_ratio、segment_labels。
    """
    global _CACHE
    if _CACHE is None:
        _CACHE = _load_cache()
    key = hashlib.sha1((text + str(merge)).encode("utf-8")).hexdigest()
    if key in _CACHE:
        return _CACHE[key]["resp"]
    body = json.dumps({"text": text, "is_merge": merge}).encode("utf-8")
    request = urllib.request.Request(API_URL, data=body, headers={
        "Authorization": "Bearer " + _read_key(),
        "Content-Type": "application/json"})
    resp = None
    for attempt in range(RETRY_TIMES):
        try:
            with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as reply:
                resp = json.loads(reply.read().decode("utf-8"))
            break
        except OSError:
            if attempt == RETRY_TIMES - 1:
                raise
            time.sleep(2 + attempt * 2)
    if resp.get("status") != "success":
        sys.exit(f"检测失败：{resp.get('msg') or resp}")
    record = {"key": key, "time": time.strftime("%Y-%m-%d %H:%M:%S"),
              "chars": len(text), "resp": resp}
    os.makedirs(HOME_DIR, exist_ok=True)
    with open(CACHE_FILE, "a", encoding="utf-8") as cache_file:
        cache_file.write(json.dumps(record, ensure_ascii=False) + "\n")
    _CACHE[key] = record
    return resp


def score(text):
    """返回一段文字的整体 AIGC 值（0 到 1，越高越像 AI）。"""
    return detect(text)["softmax_confidence"]


def _level(conf):
    if conf < HUMAN_MAX:
        return "人工"
    return "AI" if conf >= AI_MIN else "疑似"


def _preview(text, head=26, tail=10):
    flat = text.strip().replace("\n", "/")
    return flat if len(flat) <= head + tail else f"{flat[:head]}…{flat[-tail:]}"


def _read(path):
    return open(path, encoding="utf-8").read().strip() + "\n"


def cmd_check(args):
    """查分：整体结论加每个片段的分数。"""
    for path in args.files:
        text = _read(path)
        resp = detect(text, merge=not args.windows)
        ratio = resp["labels_ratio"]
        print(f"== {path}  字数 {len(text)}  整体 {resp['softmax_confidence']:.4f}  "
              f"人工 {ratio['0']:.1%}  疑似 {ratio['2']:.1%}  AI {ratio['1']:.1%}")
        for seg in resp["segment_labels"]:
            print(f"  {seg['conf']:.4f} {_level(seg['conf']):2s} {seg['position'][1]:5d}字  "
                  f"{_preview(seg['text'])}")


def _chunks(paragraphs):
    """把段落按顺序并成约 CHUNK_CHARS 字的块，不拆段落。"""
    chunks, current = [], []
    for paragraph in paragraphs:
        current.append(paragraph)
        if sum(len(p) for p in current) >= CHUNK_CHARS:
            chunks.append(current)
            current = []
    if current:
        if chunks and sum(len(p) for p in current) < MIN_REST_CHARS:
            chunks[-1].extend(current)
        else:
            chunks.append(current)
    return chunks


def _leave_one_out(parts, joiner):
    """逐个去掉一部分重测，返回 [(下降幅度, 序号, 去掉后的分数)]，按下降幅度从大到小。"""
    base = score(joiner.join(parts) + "\n")
    drops = []
    for index in range(len(parts)):
        rest = joiner.join(parts[:index] + parts[index + 1:]) + "\n"
        if len(rest) < MIN_REST_CHARS:
            continue
        after = score(rest)
        drops.append((base - after, index, after))
    return base, sorted(drops, reverse=True)


def _split_sentences(paragraph):
    return [s for s in re.findall(r"[^。！？!?…]+[。！？!?…]*[”’」）)]*", paragraph) if s.strip()]


def _report_chunk(number, chunk, deep):
    base, drops = _leave_one_out(chunk, "\n\n")
    print(f"\n块{number}  {base:.4f} {_level(base)}  {sum(len(p) for p in chunk)}字")
    drivers = [d for d in drops if d[0] >= DRIVER_DROP]
    if not drivers:
        print("  没有单独一段能解释：分数由整块写法累加，需整块换写法")
        return
    for drop, index, after in drivers:
        print(f"  去掉后 {after:.4f}（降 {drop:.2f}）：{_preview(chunk[index], 40, 16)}")
        sentences = _split_sentences(chunk[index])
        if not deep or len(sentences) < 2:
            continue
        rest = chunk[:index] + chunk[index + 1:]
        for sentence in sentences:
            kept = "".join(s for s in sentences if s is not sentence)
            trial = "\n\n".join(rest[:index] + [kept] + rest[index:]) + "\n"
            after_sentence = score(trial)
            if base - after_sentence >= DRIVER_DROP:
                print(f"      句：去掉后 {after_sentence:.4f}：{sentence.strip()}")


def cmd_locate(args):
    """定位：先按块查分，再对高分块逐段（可选逐句）去掉重测，找出拉高分数的地方。"""
    text = _read(args.file)
    paragraphs = [p for p in text.split("\n\n") if p.strip()]
    chunks = _chunks(paragraphs)
    scored = [(score("\n\n".join(chunk) + "\n"), number, chunk)
              for number, chunk in enumerate(chunks, 1)]
    print(f"== {args.file}  {len(chunks)} 块")
    for conf, number, chunk in scored:
        print(f"  块{number:2d}  {conf:.4f} {_level(conf):2s}  {_preview(chunk[0])}")
    high = sorted((s for s in scored if s[0] >= args.threshold), reverse=True)
    for conf, number, chunk in high[:args.top]:
        _report_chunk(number, chunk, args.sentences)
    if len(high) > args.top:
        print(f"\n还有 {len(high) - args.top} 个高分块没有定位，用 --top 调大")


def cmd_usage(args):
    """统计本机缓存里记录的调用次数和扣减的额度（按月）。"""
    months = {}
    for record in _load_cache().values():
        month = record.get("time", "未知")[:7]
        used = record["resp"].get("makers_models_usage", {}).get("total_tokens", 0)
        calls, tokens = months.get(month, (0, 0))
        months[month] = (calls + 1, tokens + used)
    for month, (calls, tokens) in sorted(months.items()):
        print(f"{month}  调用 {calls} 次  扣减 {tokens} token")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    check = commands.add_parser("check", help="查分")
    check.add_argument("files", nargs="+")
    check.add_argument("--windows", action="store_true", help="按约 270 字的窗口逐个给分，不合并")
    check.set_defaults(run=cmd_check)
    locate = commands.add_parser("locate", help="定位拉高分数的段落")
    locate.add_argument("file")
    locate.add_argument("--threshold", type=float, default=HUMAN_MAX, help="只定位不低于此分的块")
    locate.add_argument("--top", type=int, default=5, help="最多定位几个块（从最高分起）")
    locate.add_argument("--sentences", action="store_true", help="对找到的段落再逐句定位")
    locate.set_defaults(run=cmd_locate)
    usage = commands.add_parser("usage", help="统计用量")
    usage.set_defaults(run=cmd_usage)
    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
