"""User-facing text that the web page can show in its own language.

The backend keeps writing Chinese, but a `Text` also remembers its template and parameters. Responses and stored
records pass both along, and the page looks the template up in its dictionary (frontend/locales/en/backend.json),
the same Chinese-as-key scheme the page uses for its own strings. Anything that only reads the Chinese string
(the CLI, logs, older pages) keeps working because a `Text` is a `str`.
"""


import json
import math
import re


class Text(str):
    """Chinese text plus the template and parameters it was built from.

    Args:
        template: Chinese sentence, also the dictionary key; `{name}` marks a parameter.
        **params: Values for the placeholders; kept as given so the page can format them itself.
    """

    def __new__(cls, template, **params):
        text = super().__new__(cls, template.format(**params) if params else template)
        text.template = template
        text.params = params
        return text


def text_payload(value):
    """Return `{"template", "params"}` for a `Text`, or None for plain strings."""
    if isinstance(value, Text):
        return {"template": value.template, "params": {key: item if isinstance(item, (int, float)) else str(item)
                                                       for key, item in value.params.items()}}
    return None


def error_body(error):
    """JSON body for a failed request: the Chinese `error`, plus `error_text` when it can be translated."""
    message = error if isinstance(error, str) else (error.args[0] if getattr(error, "args", None) else str(error))
    body = {"error": str(message) if isinstance(message, str) else str(error)}
    payload = text_payload(message)
    if payload:
        body["error_text"] = payload
    return body


def save_text(connection, owner, owner_id, field, value):
    """Store a translated template alongside its legacy Chinese field."""
    if isinstance(value, Text):
        connection.execute(
            "INSERT INTO stored_texts(owner,owner_id,field,template,params) VALUES(?,?,?,?,?) "
            "ON CONFLICT(owner,owner_id,field) DO UPDATE SET template=excluded.template,params=excluded.params",
            (owner, owner_id, field, value.template, json.dumps(value.params, ensure_ascii=False)),
        )
    else:
        connection.execute("DELETE FROM stored_texts WHERE owner=? AND owner_id=? AND field=?", (owner, owner_id, field))


def load_texts(connection, owner, owner_id):
    """Load translated templates keyed by their owning record's field name."""
    return {row["field"]: {"template": row["template"], "params": json.loads(row["params"])}
            for row in connection.execute("SELECT field,template,params FROM stored_texts WHERE owner=? AND owner_id=?",
                                          (owner, owner_id))}


def incoming_text(value, payload=None):
    """Validate optional runner translation metadata against its legacy text value."""
    if payload is None:
        return value
    if not isinstance(value, str) or not isinstance(payload, dict) or set(payload) != {"template", "params"}:
        raise ValueError(Text("翻译文本数据无效"))
    template, params = payload["template"], payload["params"]
    if not isinstance(template, str) or not isinstance(params, dict) or len(template) > 32000 or len(params) > 50:
        raise ValueError(Text("翻译文本模板或参数无效"))
    fields = re.findall(r"\{([^{}]+)\}", template)
    if "{" in re.sub(r"\{[^{}]+\}", "", template) or "}" in re.sub(r"\{[^{}]+\}", "", template):
        raise ValueError(Text("翻译文本模板或参数无效"))
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", field) for field in fields):
        raise ValueError(Text("翻译文本模板或参数无效"))
    if any(not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key)
           or not isinstance(item, (str, int, float, bool)) or isinstance(item, float) and not math.isfinite(item)
           or len(str(item)) > 32000 for key, item in params.items()):
        raise ValueError(Text("翻译文本参数无效"))
    try:
        rendered = template.format(**params)
    except (KeyError, ValueError, IndexError) as error:
        raise ValueError(Text("翻译文本参数与模板不匹配")) from error
    if rendered != value:
        raise ValueError(Text("翻译文本与模板不一致"))
    return Text(template, **params)
