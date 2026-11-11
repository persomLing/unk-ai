# 上传后的接收核对与图片文件存储

## 故障定位

本次使用的匿名诊断摘要显示，任务从开始到停止持续 51.737 秒。GIF 勾选、提示词输入已经执行并核对；第 7 步上传在 `check` 阶段返回 `ERR_UPLOAD_UNCERTAIN`、`valueMatched: false`。该任务没有发送生成按钮点击。日志只保留文件列表整体比对结果，不能单凭日志确定哪个字段不匹配。

只读检查原 UU 生图页面的上传结果时，已出现同源 `blob:` 图片预览，而唯一文件输入框的 `files` 为空。这是页面接收文件后清空输入框的情况；不能再把文件列表不一致直接等同于未上传，也不能据此重传。

## 已实现的上传核对

- 正常 FileList 比对和上传逐次确认继续保留。不一致仍记录原动作 `uncertain`，不会重放这个动作。
- 仅在本次文件已经交付、目标仍有效、末尾 FileList 比对不一致时，记录上传区域的旧图片预览基线和原任务、代次、动作、参考图及文档身份。
- 侧栏重新观察页面，通过内部只读 `AGENT_VERIFY_UPLOAD` 核对本次新增或改变的局部预览。后台重新检查当前任务许可、参考图登记、站点授权、完整 URL、主/子文档和文件输入框；读取有 3 秒边界。
- 仅接受本页局部新出现且与原参考图逐字节匹配的 `data:` 或同源 `blob:` 图片。已有预览、图片计数、文件名、一般 DOM 变化和网络图片 URL 均不能单独证明本次已接收。
- 核对成功向下一次既有 Agent 决策提供已接收预览的证据，沿现有确认规则继续页面动作。这里仍为 `serverConfirmed: false`，不把本地预览声称为服务器处理成功。核对失败、停止、页面更换、权限失效或迟到结果不会触发上传重试或生成提交。

实现位于 `src/content/agent-scanner.js`、`src/background/agent-service.js`、`src/sidepanel/features/agent/agent-slot.js` 与 `action-verification.js`。未新增第二套主回复、模型请求或坐标点击路径。

## 已实现的图片文件格式

所选本地数据目录布局：

```text
<所选数据目录>/
  conversations/<会话id>.json
  images/<SHA-256>.png   # 按实际格式也可为 jpg、webp、gif
  diagnostics/...
```

正式 JSON 附件保留名称、类型、尺寸等元数据，并保存 `imageStorageVersion: 1`、`imagePath: images/<SHA-256>.<格式>`；不保存 `dataUrl`。SHA-256 以实际像素文件内容计算，同一内容可以共用文件。先完成所有图片文件写入，再替换会话 JSON，失败保留原 JSON 和 IndexedDB outbox 中的完整待写像素、版本及原目录绑定。文件写入一旦开始，沿原有会话锁完成；调用者的等待仍由现有存储 API 有界控制。

`conversation-images.js` 负责外置和读回，`local-directory.js` 只把外置后的副本写盘，`conversation-store.js` 打开单个会话时在该次捕获的目录中读回图片。历史列表不加载全量图片。单图读取为 5 秒、最多 8 MiB，并核对路径与内容摘要；路径只允许上述根目录的 `images/` 文件，不接受绝对路径或目录逃逸。读取不修改原磁盘记录，删除/撤销的 fingerprint 继续使用原始 JSON。

当前内存会话、临时会话和未同步的浏览器缓存仍保留可恢复图片数据；模型请求按服务接口要求传图，远端模型不接收电脑上的相对路径。旧内嵌图片记录仍可打开，在下一次正常保存时转换。较大的附件可能已在准备阶段缩放或压缩，保存的是插件处理后的像素，不移动或删除原上传文件。

缺图、损坏、路径或版本错误显示在历史提问和回退附件中。需要本轮图片的发送、原任务重启与包含所选提问图片的导出会明确报错；历史容量估算、无关文字问答和不包含该提问的导出仍可使用。删除会话不删除共享图片，保障其它引用及删除撤销；目前没有自动清理未引用图片，备份和移动时需要一起保留 `conversations/` 与 `images/`。

## 验证范围

图片行为回归覆盖文件顺序、JSON 无 Base64、像素读回、共用文件、旧记录转换、失败保留和原目录重试、缺图/损坏/路径及版本拒绝、删除撤销、挂起图片写入的锁和版本确认、读取期间目录切换。缺图消费者回归覆盖实际模型请求、估算、草稿/队列/Agent发送、任务重启、可见说明和所选导出。上传回归包括清空 FileList 后匹配/不匹配 blob、已有预览、异源 blob、取消/撤权/文档更换、伪造回执和原动作不重放。

真实 Chromium 的 loopback 夹具使用 OPFS、真实 IndexedDB 与 Web Locks 验证二进制文件、路径 JSON、读回、撤销和缺图，记录为 `output/playwright/conversation-images-browser-validation.json`。它没有操作用户本地数据文件夹的选择器。

最终 `npm run check`：1648 项测试全部通过，Vite 构建成功，`dist` 已更新为 `sidepanel-hAWAxYeA.js`，scanner version 11。实际构建的扩展页另验证历史缺图提示、回退附件和发送阻断：0 新回合、0 模型请求、0 页面错误，记录为 `output/playwright/image-attachment-unavailable-validation.json`。

原生 Chrome 侧栏通过 `tests/browser/agent-upload-receipt-native-extension.js` 正反两场景：匹配原 PNG 的新 blob 预览时，FileList 确实清空、上传事件仅 1 次，在第二次明确确认后本地生成提交仅 1 次；只有 1/6 计数而没有预览时，上传仍仅 1 次，任务停止且提交 0 次。核对证据进入下一次现有模型请求，保留真实扩展 sender、后台授权及动作执行，不降级权限边界。摘要记录为 `output/playwright/agent-upload-receipt-native-validation.json`。

原站只做了当前上传结果的只读检查；生成流程在隔离 Chrome 中使用本地 HTML 和可控模型响应验证，不消费用户原站的收费生成。Node 与本地浏览器通过不代表全部站点、模型供应商和完整 MV3 生命周期已实测。应用新 `dist` 后需要在扩展管理页重新加载 UNK AI，并重开侧栏。
