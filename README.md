# UNK AI

UNK AI 是一个 Chrome 侧栏 AI 助手，用于网页阅读、对话和资料整理。支持连接自选的 OpenAI 兼容模型服务，会话可保存在本地。

## 主要功能

- 阅读网页、PDF、文档和 GitHub 源码，结合内容提问。
- 上传图片与文档，预览长文本和图片细节。
- 引用回答中的内容，添加注释或打开独立追问。
- 按需联网检索、查看来源，经授权辅助操作网页。
- 管理本地会话，导出 Markdown、图片或 PDF。

## 开始使用

需要 Node.js 22.12+ 和支持侧栏的 Chrome。

```bash
npm ci
npm run build
```

在 `chrome://extensions` 开启开发者模式，选择“加载已解压的扩展程序”，加载 `dist` 目录。随后在插件设置中配置模型服务、API Key 和本地数据目录。

模型请求会发送到你配置的服务，联网功能需相应接口支持。

详细操作请看 [操作手册](docs/USER-GUIDE.md)，也可下载 [离线 HTML 阅读版](docs/USER-GUIDE.html)。
