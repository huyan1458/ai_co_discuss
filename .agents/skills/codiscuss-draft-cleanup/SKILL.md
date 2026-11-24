---
name: codiscuss-draft-cleanup
description: 盘点共议草稿，按用户指定范围恢复超限房间的派活。Inspect AI CoDiscuss drafts and recover a room blocked by its storage limit.
---

# 草稿占用与恢复 / Draft storage recovery

房间已停止派活时，在本机 AI 软件新开普通对话，输入“请用 codiscuss-draft-cleanup 盘点共议草稿”。若软件未发现技能，用 `codiscuss setup` 为该软件安装技能，然后新开对话。用受影响服务的账号和环境运行 `codiscuss service status`，优先取 JSON 的 `drafts_root` 绝对路径原样传给 `--drafts-root`。旧服务没有此字段时，改用 `--home "<home>"`。使用自定义服务目录或托管账号时核对实例。以下脚本路径相对本技能目录。

When dispatch is blocked, open a new conversation outside the room in your local AI app and ask it to use codiscuss-draft-cleanup to inspect your drafts. Install the skills for that app with `codiscuss setup` if needed. Run `codiscuss service status` as the affected service account with its environment and pass the reported absolute `drafts_root` directly to `--drafts-root`. For older services without that field, use `--home "<home>"`. Run the scripts from this skill's installed folder.

1. 默认只盘点。运行 `python scan.py --drafts-root "<drafts_root>"`，按房间、成员和执行查看逻辑字节数及不可读项。legacy 汇总包含成品和未提交内容。硬链接可能重复计数。Inspect the read-only inventory and scan errors. Legacy totals can include unique deliverables and pending work.
2. 查清候选路径、对应任务是否已结束、用途、保留的原件或可复现步骤。向用户列出精确路径、大小及依据。用户只要求检查就到此结束。List exact candidates, sizes, evidence of completion and how each can be reconstructed. Stop after inventory for an inspection-only request.
3. 对草稿内重复的归档，运行 `python cleanup.py --drafts-root "<drafts_root>" --keep "<room/member/original.zip>" --drop "<room/member/copy.zip>"`。默认仅预览，逐份比较 SHA-256。获准后，复核执行仍已结束，对同一对路径追加 `--apply`。支持普通 tar、tgz 和 zip，使用共议安装所需的 Python 3.10+。Preview duplicate archives first. Apply only after the user explicitly approves the listed paths.
4. 对其他旧副本，逐文件与原件核对后再申请授权。唯一成品、待提交修改或来源不明的文件保留。需迁出唯一成品时，让用户选定永久目录，先复制并校验，再经授权删除草稿副本。删除前重新检查范围在已核对的草稿根目录内；遇到重定向、不可读项或内容变化就跳过。For other legacy copies, verify each against its source and obtain approval. Preserve unique and unverified files. Before removal, recheck paths, contents and task state. Skip redirected or unreadable paths.
5. 复跑盘点、核对可用磁盘空间，通过 `codiscuss admin storage` 查看各项限额。清理后即可回到房间手动重试原请求。Recheck disk space and quotas, then manually retry the request from the room.
