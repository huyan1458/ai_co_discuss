"""Participant identities: an AI platform is a type, a room participant is one named instance of it.

`Claude` and `Claude-评审` are two instances of the Claude platform in the same room; each keeps its
own session, model and thinking effort. Platform names alone keep their historical meaning.
"""

import re

USER = "用户"
AI_PLATFORMS = ("Codex", "Claude", "Gemini", "DeepSeek", "Qwen")
PARTICIPANTS = [USER, *AI_PLATFORMS]
MAX_INSTANCE_SUFFIX = 16
# AI instances one room may hold, across platforms.
MAX_ROOM_AGENTS = 12
INSTANCE_PATTERN = re.compile(rf"({'|'.join(AI_PLATFORMS)})(?:-[0-9A-Za-z_一-鿿]{{1,{MAX_INSTANCE_SUFFIX}}})?")


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
