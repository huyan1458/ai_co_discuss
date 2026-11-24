---
name: share-card
description: 为 AI CoDiscuss 当前房间或指定房间制作分享卡封面。用户只需给出想突出的内容，例如成品、协作过程或讨论结论。按房间真实素材制作并交付可上传的 PNG。
---

# 房间分享卡

从用户给的侧重点做出一张可直接使用的封面。示例：`$share-card 为 <房间链接> 做分享卡，重点展示最终产品。` 在目标房间内说“重点展示最终产品”即可。

1. **找到房间。** 优先用本次消息或上下文里明确指定的房间。链接取查询参数 `room`，ID 可直接用，只有房间名时用 `codiscuss room list` 匹配；重名且无法确定时再问。没有指定其他房间时用当前任务绑定的房间。跨房间只读同一站点的素材，保留当前任务凭据。
2. **按主题取材。** 运行 `codiscuss share-card materials [房间ID]`，同站点完整链接可用 `--site <链接的源站>` 核对。侧重产品就先看真实成品图和交付结果，侧重协作就看并发曲线和执行统计，侧重讨论就提炼分歧和结论。根据 `scope` 标明部分统计，省略无法核实的内容。数字、操作步骤、文件路径由你处理。
3. **制作并检查 PNG。** 在自己的草稿目录写 750 CSS 像素宽的静态 HTML，图片用本地素材，图表可用内联 SVG。运行 `codiscuss share-card render cover.html --out cover.png`，检查成图清晰且内容完整。二维码、域名和到期时间由分享面板追加。完整素材字段、尺寸和渲染说明见[制卡参考](references/share-card.md)。
4. **交付成图。** 在房间任务中用 `codiscuss attachment upload --file <PNG路径>` 上传至接单房间，再用 `message post --attachment <返回的附件ID>` 随本次回答提交。跨房间时说明到目标房间的“已分享 → 查看分享卡 → 上传封面”选用这张 PNG。终端里直接交付可打开的文件路径。

若本机安装版尚无 `share-card` 子命令，使用可访问的共议源码入口 `node "<仓库>/runner/codiscuss.mjs" share-card ...`。开发机可在 `~/.codiscuss/share-card-cli.txt` 指定该入口的绝对路径。普通房间和附件命令仍用任务指定的 CLI。
