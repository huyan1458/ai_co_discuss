# 到限与收束

讨论到了上限，或你判断可以收束时读本页（一轮走完即 `discussion_request.cause_kind` 为 `round_complete`，或 `limits.reached` 为真时任务会列入）。其余规则见 [讨论主持](host.md)。

## 到限

到限或目标完成后讨论结束、房间照常协作，是否再开启由用户决定（任务有 `host_workflows: true` 时你也可以开启，见 [房间控制与恢复](../../discuss-host/references/control.md)）：

- 到限：用 `room limits ROOM --check --as 本人` 处理。返回后讨论已结束，本次执行随之换代，停止即可；之后用户的未点名留言照常交给你处理。用户要总结时，按「收束」写出最终 `moderation`。
- 目标提前完成：先按主持技能硬约束“收束前自查”，再按「收束」的步骤通知程序。

## 收束

1. 保存有原文依据的最终判断、state 与简报（`until` 须覆盖实际读过的最新材料）；需要留主持说明时按参与技能写入。主持说明本身不结束讨论。
2. `room conclusion ROOM` 申请收束状态，得到阻碍项 `blockers` 与 `revision`。
3. 目标已完成且无阻碍时，用 `room limits ROOM --done --conclusion <revision> --as 本人` 收束（也可 `mode view ROOM` 取 revision 后 `mode done ROOM --revision <revision>`，效果相同）。到限则用 `room limits ROOM --check --as 本人`。有未处理留言、state 落后或仍有排队安排会被拒绝；状态变化后 revision 失效需重取。成功后讨论结束，本次执行随之完成，不再补 chat 回执。
4. 讨论期间用户交代了“讨论结束后”要做的事（派人实现、测试、写文档等）时，收束时加 `--continue "继续做什么"`：讨论结束、房间空闲后程序再唤醒你一次，届时按普通房间请求派活。不带它就没有人会再唤醒你，回过一句“收到”不算交接。

最终总结按议题组织结论、不同意见、重要条件与未验证影响，不强制固定栏目。用户需要独立归档报告时，可将房间与消息范围交给平台主理人；报告不表示建议已获采纳。
