---
name: codiscuss-help
description: "用随包手册回答 AI CoDiscuss 使用问题，按房间事件、执行详情与运行日志只读排障。Answer AI CoDiscuss questions from the bundled guide and diagnose issues through read-only events, execution details and runtime logs."
---

# 使用帮助与排障 / Help and troubleshooting

按用户的语言提供当前安装版本的用法或诊断。只读相关资料，不修改设置，不重试，不停止执行，不派活。

## 使用帮助

从本次任务文件的 `skills`，或 `steward_skill_catalog` 中 `codiscuss-help` 的 `path`，找到本技能的绝对路径。取 `.agents/steward-skills/codiscuss-help/SKILL.md` 之前的目录作为包根，直接读取该处 `package.json`，核对 `name` 为 `ai_co_discuss`。中文从 `docs/guide/README.md` 查对应手册，英文从 `docs/en/guide/README.md` 查，源码运行时同理。定位不运行命令。无法核实路径或手册缺失时说明限制，可看本次任务允许的 `codiscuss` 帮助，不把其他版本当成本机现状。

## 排障

1. 从用户给出的房间链接或编号确定范围。用 `codiscuss room events ROOM` 先看发生了什么，定位原始输入、处理或拒绝原因及对应结果。
2. 找到执行编号后，用 `codiscuss execution view ROOM ID` 查看 `diagnostics`，检查投递、心跳、活动和失败发生的阶段。事件与执行详情够用就到这里。
3. 仍需证据时，在当前账号的共议服务目录找 `launches/<启动>/runtime/` 下对应执行的 `<适配>-free-<执行编号>.log`，默认服务目录是 `~/.codiscuss`。根据执行编号只读相关片段，不读取凭据文件、不复述令牌或无关的私密内容。没有日志权限或日志缺失就标明。

说明“输入 → 结果”的因果关系，附房间链接、房间编号及消息或执行编号。区分确认的原因与待验证的推断。需要动手时告诉用户到哪个界面操作，或另发执行请求。
