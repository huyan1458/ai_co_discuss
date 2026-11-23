"""Text-only folding for the CLI and its server-side page budget."""

import re


QUOTE = re.compile(r"^(?: {0,3}>[ \t]?)+")
LIST = re.compile(r"^ {0,3}(?:[-+*]|[0-9]{1,9}[.)])[ \t]{1,4}")
FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})([^\n]*)$")


def fold_visual_fences(text, english=False):
    """Replace visual fences with their code-point count, leaving other fenced code alone."""
    if "visual" not in text:
        return text
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    output, fence, indent, previous_depth = [], None, 0, 0
    for index, line in enumerate(lines):
        quote = QUOTE.match(line)
        prefix = quote[0] if quote else ""
        depth = prefix.count(">")
        rest = line[len(prefix):]
        if depth != previous_depth:
            indent = 0
        previous_depth = depth
        if fence and (depth != fence[2] or (rest.strip() and not rest.startswith(" " * fence[3]))):
            finish_fence(output, lines, fence, index, english)
            fence = None
        if fence:
            close = FENCE.match(rest[fence[3]:])
            if close and close[1][0] == fence[0][0] and len(close[1]) >= len(fence[0]) and not close[2].strip():
                finish_fence(output, lines, fence, index, english, closed=True)
                fence = None
            continue
        item = LIST.match(rest)
        indent = len(item[0]) if item else indent if not rest.strip() or rest.startswith(" " * indent) else 0
        opening = FENCE.match(rest[indent:])
        if opening and (opening[1][0] != "`" or "`" not in opening[2]):
            fence = (opening[1], opening[2].strip() == "visual", depth, indent, index, prefix + (item[0] if item else " " * indent))
        else:
            output.append(line)
    if fence:
        finish_fence(output, lines, fence, len(lines), english)
    return "\n".join(output)


def finish_fence(output, lines, fence, end, english, *, closed=False):
    """Write the original ordinary fence, or one line in place of a visual fence."""
    _marker, visual, _depth, _indent, start, prefix = fence
    if not visual:
        output.extend(lines[start:end + closed])
        return
    count = len("\n".join(lines[start + 1:end]))
    label = f"[Interactive visualization · {count} characters]" if english else f"[交互式可视化 · {count} 字符]"
    output.append(prefix + label)


def fold_message_visuals(message, english=False):
    """Return only the list projection with visual sources folded."""
    return {**message, **{key: fold_visual_fences(message[key], english) for key in ("text", "summary") if isinstance(message.get(key), str)}}
