# 贡献指南

感谢你对 QuickNote 的关注。本文档说明本地开发、代码约定与提交规范。

## 开发环境

见 [README → 本地开发](./README.md#本地开发)。

首次拉起项目时，最容易卡住的两处已在那节说明：

1. 启动需分两步（绕开 Windows 下 PATH 中异常 `npm` 的问题）
2. Vite 需强制监听 IPv4（否则 WebView2 白屏）

## 代码约定

### 前端

- **原生 ES Modules，不引入框架。** 项目刻意保持零运行时依赖，以换取小体积与快启动。
  新增功能请沿用现有模块划分，不要擅自引入 React/Vue 等框架。
- **模块职责单一**：数据访问统一走 `src/cloud.js`，不要在各业务模块里直接调用 SDK。
- **注释写「为什么」，不写「是什么」。** 现有代码里大量注释解释的是踩过的坑与取舍理由，
  请保持这一风格 —— 这类信息比复述代码更有价值。
- **HTML 转义**：所有插值进 `innerHTML` 的用户数据必须经 `esc()` 处理。
- **异步竞态**：涉及视图切换的渲染逻辑，需使用 `view-guard.js` 的
  `beginView` / `staleView` 守卫，避免旧请求覆盖新视图。

### Rust / 打包

- `tauri` 版本已钉死（见记忆档案），**不要随手升级** —— 请求 Origin 方案对 webview 版本敏感。
- 修改 `tauri.conf.json` 时注意：`additionalBrowserArgs` 会**整体替换**框架默认参数，
  增删时需带全默认项。

## 提交规范

采用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/)：

```
<type>(<scope>): <subject>
```

常用 type：

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修复缺陷 |
| `chore` | 构建 / 依赖 / 杂项 |
| `docs` | 文档 |
| `refactor` | 重构（不改变外部行为） |

示例：

```
feat(report): 客户跟进选择客户时自动带出默认联系人
fix(auth): 会话无效时主动登出，避免反复读取坏凭证
```

## 提交流程

1. 从 `main` 拉出分支：`git checkout -b feat/your-feature`
2. 本地自测（`npm run dev` 或 `npm run tauri dev`）
3. 提交并推送，发起 Pull Request
4. 确保 CI 构建通过

## 发版

发版由维护者执行，步骤见 [README → 发版流程](./README.md#发版流程)。
**不要自行推 tag** —— 推 tag 会触发正式发版并覆盖线上更新源。

## 安全

- **严禁把任何密钥写入源码或提交历史。** 云端连接参数放在 `.env.local`（已 gitignore），
  CI 构建时通过 Secrets 注入。
- 如不慎提交了敏感信息，请立即联系维护者轮换密钥 —— 仅删除文件不足以清除 git 历史。
