"""Store group chat attribution separately from the room's owner and member identities."""

from .texts import Text


GROUP_KIND = "steward_group"
EXTERNAL_SOURCE = "external"
EXTERNAL_FIELDS = ("sender_id", "sender_name", "message_id", "mentioned", "owner")


def validate_message_flags(room, payload, actor):
    """Accept special group fields only on the role that may supply them."""
    group = room["system_kind"] == GROUP_KIND
    if "external" in payload and not group:
        raise ValueError(Text("external 只用于群窗口"))
    if "silent" in payload:
        if not group or actor == "用户" or payload.get("kind") not in (None, "chat") or type(payload["silent"]) is not bool:
            raise ValueError(Text("silent 只能作为群窗口回答的布尔值"))
    if not group:
        return
    if actor == "用户" and "external" not in payload:
        raise ValueError(Text("群窗口的外部消息须带 external 来源"))
    if actor != "用户" and "external" in payload:
        raise PermissionError(Text("只有本房间的控制凭据能提交外部消息"))
    if payload.get("proactive") is True or payload.get("steward_proactive") is True:
        raise PermissionError(Text("群窗口不能提交主动发言"))


def external_fields(payload):
    """Validate the channel identity without treating a display name as authority."""
    origin = payload["external"]
    if not isinstance(origin, dict) or any(
        not isinstance(origin.get(name), str) or not origin[name].strip() or len(origin[name]) > 256
        for name in EXTERNAL_FIELDS[:3]
    ) or any(type(origin.get(name)) is not bool for name in EXTERNAL_FIELDS[3:]):
        raise ValueError(Text("external 须包含发言人编号、显示名、渠道消息编号以及两个布尔值"))
    return tuple(origin[name] for name in EXTERNAL_FIELDS)


def external_origin(connection, message_id):
    """Project the original group event without confusing its channel ID with the local ID."""
    origin = connection.execute("""SELECT sender_id,sender_name,platform_message_id AS message_id,mentioned,owner
        FROM external_message_sources WHERE message_id=?""", (message_id,)).fetchone()
    return {**origin, "mentioned": bool(origin["mentioned"]), "owner": bool(origin["owner"])} if origin else None
