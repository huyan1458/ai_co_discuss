# 协作房间中的讨论参与

本页用于协作房间中的讨论请求。房间模式始终是 `free`；自动任务用 `discussion_request.purpose` 区分专家 `discuss` 请求与主持 `discuss_host` 请求，`session.phase` 标明讨论阶段。收到主持任务时另读 discuss-host；没有 `discussion_request` 时按 [自由协作](free.md) 处理。

## 硬约束

1. **只回答交给自己的当前请求**。自动专家只处理 `discussion_request.purpose: "discuss"`；手动成员只处理 `room view` 中属于自己的待处理请求。主持人只按主持技能处理 `discuss_host`。
2. **暂停、结束或 `limits.reached` 时不新增专家回答**，保留草稿，交由主持人处理。
3. **`initial` 阶段独立判断**：只读议题资料、自身材料与任务中 `read_until` 允许的内容；不要因问题文字或用户留言扩大读取范围。已经受他人观点影响就如实说明，不补称独立判断。

## 先核验请求

### 自动任务

任务文件给出房间、成员、`execution_id`、`discussion_request`、`session.phase`、读取边界及凭据方式。首次处理时先运行 `execution view ROOM 执行编号 --access-file FILE` 核验执行仍有效，再读 `room view ROOM` 核对请求、阶段与房间状态。任务过期、请求已取消或讨论已暂停/结束时保留草稿并停止。

仅当 `discussion_request.purpose` 是 `discuss` 且这是自己的当前请求时作答；`discuss_host` 由主持技能处理。`session.phase` 与任务中 `read_until` 是读取边界，房间视图用于确认当前状态，不以旧任务文字覆盖服务端状态。

### 手动成员

先按 [手动接入](manual.md) 使用自己的成员凭据注册。之后从 `room view ROOM` 的 `free.requests` 核对自己的待处理请求编号与用途；未注册或没有属于自己的请求时不发言。

## 阅读与回答

`initial` 阶段按任务的 `read_until` 停在服务端允许的范围内，不读取其后的专家观点；进入 `discussing` 后读取与争点有关的原文。回答真正的问题，检验关键假设与证据，指出会改变判断的条件；不以重复上一位观点或赞同人数代替分析。

读取须沿用自己的凭据和本次执行或请求关联；匿名入口同样受初始读取边界限制，不可去掉凭据或改用备份、执行结果、过程说明绕过。直接提问使用它自己的有效请求或执行读取，不借用讨论请求。

自动任务用本次执行编号保存一次完整回答，例如：

```sh
codiscuss message post ROOM --as 本人 --kind chat --execution 执行编号 --body-file draft.md --submission-id 新UUID --access-file FILE
```

手动成员用自己的成员凭据和服务端给出的请求编号：

```sh
codiscuss message post ROOM --as 本人 --kind chat --request 请求编号 --body-file draft.md --submission-id 新UUID --access-file FILE
```

需要摘要时一并使用 `--summary` 或 `--summary-file`。成功提交后当前请求即完成；不要再补一条普通 chat 或运行回执。

任务执行失败时，用 `execution fail ROOM 执行编号 --reason 原因 --access-file FILE` 失败本次执行并保留草稿。该操作只处理当前请求，不自动暂停整场讨论；主持人会收到专家请求失败并判断后续安排。不要改用其他成员、请求编号或身份绕过拒绝。
