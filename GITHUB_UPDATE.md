# GitHub 更新说明

## 先确认一件事

这个项目包含 Node.js 后端、SQLite 数据库和 Dify 调用，所以不能只把 `public/` 文件夹发布成 GitHub Pages 后就直接生成故事。GitHub Pages 只能展示静态页面，不能运行 `server.mjs`，也不能安全保存 `DIFY_API_KEY`。

## 更新已有 GitHub 仓库

1. 解压本项目包。
2. 打开你之前的 GitHub 仓库，点击 **Add file → Upload files**。
3. 将解压后的项目文件全部拖入上传区域。
4. 不要上传 `.env`，也不要上传 `data/` 文件夹里的 SQLite 文件。
5. 点击 **Commit changes** 完成更新。

## 运行生成接口需要什么

GitHub 只负责保存和更新代码。要让朋友真正生成故事，还需要一个能运行 Node.js 服务的后端平台，并在该平台的服务端环境变量中填写：

```env
STORY_PROVIDER=dify
DIFY_BASE_URL=https://api.dify.ai/v1
DIFY_API_KEY=只填写服务端的Dify应用密钥
DIFY_RESPONSE_FIELD=result_json
DIFY_COMPILE_REPAIR_ATTEMPTS=5
INVITE_CODE=给体验者的体验码
```

不要把这些变量写进前端文件、GitHub Pages 或截图中。

设置 `INVITE_CODE` 后，朋友打开网站会先看到体验码入口；验证通过后才能创建故事和调用生成接口。网页与后端最好由同一个 Node 服务提供，这样不需要额外配置跨域，也不会把 Dify 信息暴露给访客。

## 本地验证

```bash
npm install
cp .env.example .env
npm start
```

浏览器打开 `http://127.0.0.1:5174/`。
