# 她从何而来：网页互动叙事

这是一个独立的本地网页项目，按照同目录下的 PRD 实现家庭/校园/都市互动叙事流程。前端只访问本项目后端；模型或 Dify 密钥只由服务端读取。

## 启动

```bash
cp .env.example .env
npm start
```

浏览器打开 `http://127.0.0.1:5174/`。服务默认监听 `0.0.0.0`，因此同一份代码也可以直接放到支持 Node.js 或 Docker 的后端平台。默认 `STORY_PROVIDER=api`，使用 `qwen3.7-flash` 和 DashScope OpenAI 兼容接口；没有配置模型 API Key 时会明确提示 API 未配置，不会静默播放 Mock 故事。

也可以把生成链路切换为 Dify Workflow：

```env
STORY_PROVIDER=dify
DIFY_BASE_URL=https://api.dify.ai/v1
DIFY_API_KEY=只填写服务端的 Dify 应用密钥
DIFY_RESPONSE_FIELD=result_json
DIFY_TIMEOUT_MS=90000
DIFY_COMPILE_REPAIR_ATTEMPTS=5
```

Dify 工作流搭建、变量、五个任务分支和测试步骤见 `../开发交接/04-Dify工作流搭建说明.md`。Dify 应用需要发布后才能被本地服务调用；没有配置 `DIFY_API_KEY` 时不会静默回退到 Mock。

内部自动化测试可显式启用测试桩：

```bash
STORY_PROVIDER=mock DATABASE_FILE=./data/test.sqlite npm test
```

测试桩只用于测试，不代表真实 API 试用版已验收。

## 配置

将 `.env.example` 复制为 `.env` 后填写服务端变量。默认模型为 `qwen3.7-flash`，并关闭 thinking；预算和单价仍需按实际账号与官方文档确认。兼容保留了 `DEEPSEEK_*` 变量，但不应与 Qwen 配置混用。API Key 只放在服务端 `.env`，不要在前端设置，也不要把密钥提交到版本库。

`STORY_PROVIDER` 有三种值：

- `mock`：仅供自动化测试，使用本地测试桩；
- `api`：直接调用 Qwen 等 OpenAI 兼容接口；
- `dify`：调用已经发布的 Dify Workflow，由 Dify 内部配置 Qwen。

如果要给朋友体验，可以在服务端 `.env` 设置体验码：

```env
INVITE_CODE=只告诉朋友的体验码
```

设置后，网页本身仍然可以打开，但故事创建和生成接口会先要求输入体验码。体验码只作为访问门槛；Dify 密钥仍然只放在后端环境变量中，绝不放进 `public/` 或提交到 GitHub。

仓库中的 `Dockerfile` 会让同一个服务同时提供网页和 `/api` 接口。部署时只需要在平台后台设置环境变量，不需要把 `.env` 上传到 GitHub。

## 已实现范围

- 角色创建、家庭/校园/都市分类和动态情境提案
- 选择提案、换一批、用户自定义情境
- 开场、第一次行动、中段、第二次行动、具体积极结局
- 自定义行动真实进入后端任务包
- 当前路线持久化、路线分支保存、刷新恢复和已有结果缓存
- 1000–3000 字第三人称完整短篇成稿校验、复制和 UTF-8 TXT 导出
- `compile` 校验失败后最多自动修订5次；每次将校验反馈和上一版不合格成稿带回同一条路线，不会写入不合格正文
- 服务端加载 `../开发交接/02-故事生成系统提示词.txt`
- 可切换的 Dify Workflow Provider；任务规划、路线上下文和模型输出校验分别由 `agent/` 模块负责
- SQLite 任务、节点、路线、额度、模型用量和费用记录
- 幂等请求、超时、限流、预算、授权失败、余额不足和格式错误提示

## 真实验收状态

代码和 Mock 自动化测试可以在没有密钥时运行；真实 Qwen API 内容验收需要在本地配置真实凭据和批准预算后进行。Dify 真实验收还需要先在 Dify 中完成并发布 Workflow，再配置 `DIFY_API_KEY`。真实调用不会自动降级到 Mock。
