"""Initialize task-ledger documents without overwriting existing work."""
from __future__ import annotations

import argparse
import logging
from datetime import date
from pathlib import Path


SKILL_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_DIR = SKILL_ROOT / "templates"
DOCUMENT_NAMES = ("README.md", "PLAN.md", "TODO.md")


def render_template(template: str, values: dict[str, str]) -> str:
    """Replace task-template placeholders with concrete values."""
    rendered = template
    for key, value in values.items():
        rendered = rendered.replace("{{" + key + "}}", value)
    return rendered


def initialize_task_node(target: Path, name: str, parent: str) -> Path:
    """Create README, PLAN and TODO; return the created README path."""
    resolved_target = target.resolve()
    output_path = resolved_target / "README.md"
    for document_name in DOCUMENT_NAMES:
        document_path = resolved_target / document_name
        if document_path.exists():
            raise FileExistsError(f"拒绝覆盖已有任务文档：{document_path}")

    resolved_target.mkdir(parents=True, exist_ok=True)
    values = {
        "TASK_NAME": name,
        "TASK_DIR": str(resolved_target),
        "PARENT_TASK": parent or "无（根任务）",
        "CREATED_DATE": date.today().isoformat(),
    }
    documents = {
        document_name: render_template(
            (TEMPLATE_DIR / document_name).read_text(encoding="utf-8"), values
        )
        for document_name in DOCUMENT_NAMES
    }
    for document_name, content in documents.items():
        with (resolved_target / document_name).open("x", encoding="utf-8") as document_file:
            document_file.write(content)
    return output_path


def main() -> None:
    """Parse CLI arguments and initialize a task node."""
    parser = argparse.ArgumentParser(
        description="初始化任务节点的 README.md、PLAN.md 和 TODO.md",
    )
    parser.add_argument("target", type=Path, help="任务目录")
    parser.add_argument("--name", required=True, help="任务名称")
    parser.add_argument("--parent", default="", help="父任务名称或路径")
    args = parser.parse_args()

    try:
        created = initialize_task_node(args.target, args.name, args.parent)
    except FileExistsError as error:
        parser.exit(2, f"错误：{error}\n")

    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.info("已创建任务文档：%s", created.parent)


if __name__ == "__main__":
    main()
