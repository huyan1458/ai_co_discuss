---
name: codiscuss-draft-cleanup
description: "盘点 AI CoDiscuss 的成员草稿、运行日志、工作流备份、房间附件与本机语音模型，并协助按用户批准的范围清理。不扫描整个磁盘。Inventory CoDiscuss drafts, logs, workflow backups, attachments and local speech models, and help clean up explicitly approved items."
---

# 共议占用盘点与清理 / CoDiscuss storage inventory and cleanup

由平台主理人按请求读取，不装进各 AI 软件。管理面板“存储”中的“让平台主理人分析占用”默认只盘点。若存储限制让主理人也不能接单，请用户先从管理面板释放空间。只检查该共议账号的目录，不扫描整盘、项目目录或其他 AI 软件的数据。

The steward loads this skill on request. “Ask the platform steward to analyze storage” in the admin panel starts a read-only inventory. If storage limits prevent dispatch, ask the user to free space in the admin panel first. Limit the work to this CoDiscuss account, not the whole disk, project folders or other AI apps.

## 盘点 / Inventory

1. 用受影响账号运行 `codiscuss service status`，核对返回的 `home`、`drafts_root`；管理面板请求若给出账号目录，须与该实例一致。目录无法确认时不猜。运行 `python scan.py --home "<home>" --drafts-root "<drafts_root>"`（脚本路径相对本技能目录，Python 3.10+）。旧版无 `drafts_root` 时只传 `--home`。
2. 汇报五类占用、位置与不可读项。数字是逻辑字节，硬链接可能重复计数。附件另外按管理面板或 `codiscuss admin storage attachments` 核对房间及远端对象；本地盘点不会把远端对象算作可释放的磁盘空间。
3. 要清理时，先列精确候选路径或附件编号、大小、来源、运行状态和可恢复依据。唯一成品、未提交修改、重定向、不可读或来源不明的数据保留。先预览，用户逐项批准后才处理，清理后复查实际占用。只要求盘点就不删除。

Use the affected account's `codiscuss service status` to verify `home` and `drafts_root`. Use the exact paths and report logical bytes and unreadable entries. Present exact paths or attachment IDs, sizes, and evidence of eligibility or recoverability. Preview first and process only items the user approves. Recheck usage afterwards. An inventory request does not authorize deletion.

## 分类别处理 / Cleanup by category

| 类别 / Category | 做法 / Action |
| --- | --- |
| 成员草稿 / Drafts | 结束执行留下的可重建临时文件优先用房间或管理面板的清理功能。重复归档用 `cleanup.py --drafts-root "<drafts_root>" --keep "ROOM/MEMBER/original.zip" --drop "ROOM/MEMBER/copy.zip"` 比对 SHA-256。确保执行已结束，只对同一对用户批准的普通 tar、tgz 或 zip 追加 `--apply`。Use the built-in cleanup for eligible scratch files, or preview a verified duplicate and apply only to the exact approved pair. |
| 运行日志 / Run logs | 日志位于 `launches/*/runtime/`。只选已结束启动中明确可删的日志。运行锁仍在或状态不明就保留，不自行停服务或移除运行锁。逐个使用 `cleanup.py --home "<home>" --log "LAUNCH/runtime/FILE.log"` 先预览，获准后加 `--apply`。Never touch active or uncertain launches. Preview and apply to one approved log path at a time. |
| 工作流备份 / Workflow backups | 只选 `backups/workflow-*/` 中已确认可放弃的旧备份文件，不改正在使用的工作流或其他备份。逐个用 `cleanup.py --home "<home>" --workflow-backup "workflow-BACKUP/FILE"` 预览，获准后加 `--apply`。脚本不递归删除目录。Never touch live workflows, other backups, or recursively delete a backup directory. |
| 房间附件 / Attachments | 不直接删文件。请房主在房间用“管理附件”，或由管理员用 `codiscuss admin storage attachments ROOM clear ID... --confirm`。消息记录与缩略图保留。Use the room or admin attachment controls rather than unlinking the backing files. |
| 本机语音模型 / Local speech models | 仅盘点安装位置与大小。卸载另按主理人技能 `local-tts-setup` 或 `local-stt-setup` 的卸载步骤处理。Inventory only. Use the matching speech setup skill for uninstallation. |
