"""Participant identities: an AI platform is a type, a room participant is one named instance of it.

`Claude` and `Claude-review` are two instances of the Claude platform in the same room; each keeps its
own session, model and thinking effort. Platform names alone keep their historical meaning.
"""

import re

USER = "用户"
AI_PLATFORMS = ("Codex", "Claude", "Antigravity", "DeepSeek", "Qwen", "Grok")
PARTICIPANTS = [USER, *AI_PLATFORMS]
MAX_INSTANCE_SUFFIX = 16
# AI instances one room may hold, across platforms.
MAX_ROOM_AGENTS = 12
INSTANCE_PATTERN = re.compile(rf"({'|'.join(AI_PLATFORMS)})(?:-[0-9A-Za-z_]{{1,{MAX_INSTANCE_SUFFIX}}})?")
# The name people and AIs call a platform when it differs from its ID; web/app.js PLATFORM_IDENTITIES shows the same.
PLATFORM_NICKNAMES = {"Antigravity": "Gemini"}


def is_ai(name):
    """Whether a name is an AI platform or a named instance of one."""
    return isinstance(name, str) and INSTANCE_PATTERN.fullmatch(name) is not None


def is_participant(name):
    """Whether a name may author, submit or be scheduled: the user or any AI instance."""
    return name == USER or is_ai(name)


def platform_of(name):
    """Return the platform an AI instance belongs to, or None for the user and invalid names."""
    match = INSTANCE_PATTERN.fullmatch(name) if isinstance(name, str) else None
    return match.group(1) if match else None


def default_label(name):
    """The name an instance goes by without an owner's label: its platform's nickname plus its own suffix (Antigravity-2 → Gemini-2)."""
    platform = platform_of(name)
    nickname = PLATFORM_NICKNAMES.get(platform)
    return nickname + name[len(platform):] if nickname else name
