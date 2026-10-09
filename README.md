# QuickNote

> 一款轻量的桌面便签 + 项目填报工具，面向需要每天记录工作、按项目沉淀数据的团队。

基于 **Tauri v2** 构建，安装包约 6 MB，常驻内存低，启动秒开。支持便签速记、项目工时填报、
客户跟进、数据汇总统计，以及**应用内一键自动更新**。

---

## 功能

| 模块 | 说明 |
|---|---|
| **便签** | 按日期记录待办，热力图标示活跃度；支持钉在桌面、快速添加与勾选完成 |
| **项目填报** | 按项目编码 / 任务名填报工时与进展，支持日期范围查询与汇总 |
| **客户跟进** | 维护客户清单（含默认联系人），跟进记录选择客户时自动带出联系人 |
| **数据汇总** | 管理页可按项目、人员、客户多维度统计，支持导出 |
| **自动更新** | 启动后静默检查新版本，顶部提示条一键升级，安装包经签名校验 |

## 技术栈

- **前端**：原生 JavaScript（ES Modules），无框架、无构建期依赖 —— 打包体积小、启动快
- **桌面容器**：Tauri v2（Rust）
- **后端**：WorkBuddy 云服务（数据库 / 用户认证 / 权限控制）
- **打包**：NSIS（Windows）、`.app.tar.gz` + `.dmg`（macOS）

## 目录结构

```
quicknote/
├── index.html            入口页面（含关键内联样式，避免首屏白屏）
├── src/
│   ├── main.js           便签模块
│   ├── report.js         项目填报模块
│   ├── admin.js          管理页（汇总 / 历史 / 客户 / 人员）
│   ├── auth.js           登录门禁（邮箱 OTP 验证）
│   ├── cloud.js          数据层统一入口（含请求缓存）
│   ├── updater.js        应用内自动更新
│   ├── export.js         数据导出
│   └── view-guard.js     视图竞态守卫
├── src-tauri/            Rust 侧（窗口、插件、打包配置）
│   └── tauri.conf.json   ⚠️ 版本号与更新地址在这里
├── scripts/
│   └── publish-update.py 生成自动更新清单 latest.json
└── .github/workflows/
    └── build-packages.yml 双平台构建 + 发版流水线
```

## 本地开发

### 环境要求

- Node.js 22+
- Rust 稳定版工具链
- Windows 需 WebView2 运行时（Win10 1803+ 通常已预装）

### 步骤

```bash
# 1. 安装前端依赖
npm install

# 2. 配置云端连接参数（模板见 .env.example）
cp .env.example .env.local
#    然后填入 VITE_CLOUD_ENDPOINT / VITE_CLOUD_KEY

# 3. 启动桌面应用（推荐两步，见下方说明）
npm run dev -- --host 127.0.0.1          # 终端 1：启动前端 dev server
npm run tauri dev -- --config '{"build":{"beforeDevCommand":null}}'   # 终端 2
```

> **为什么要分两步？**
> `npm run tauri dev` 会自己拉起 `npm run dev`，但在部分 Windows 环境下，
> PATH 中若存在无扩展名的 `npm`（Unix 脚本），Rust 的进程创建会失败。
> 分两步可完全绕开该问题，且不修改仓库配置。
>
> `--host 127.0.0.1` 是必要的：Vite 6 默认可能只监听 IPv6 的 `[::1]`，
> 而 WebView2 请求的是 IPv4，会导致窗口白屏。

### 纯前端调试

```bash
npm run dev
# 浏览器打开 http://localhost:1420（不含桌面壳）
```

## 发版流程

自动更新依赖 GitHub Release 托管清单，**必须走 tag 触发**：

1. **三处版本号保持一致**
   - `package.json` → `version`
   - `src-tauri/Cargo.toml` → `version`
   - `src-tauri/tauri.conf.json` → `version`

2. **提交并提交 tag**

   ```bash
   git add -A && git commit -m "chore(release): vX.Y.Z"
   git push
   git tag vX.Y.Z && git push origin vX.Y.Z
   ```

3. **CI 自动执行**：双平台构建 → 签名 → 建 Release → 生成并上传 `latest.json`

4. **客户端**用固定链接获取清单：
   `https://github.com/<owner>/<repo>/releases/latest/download/latest.json`

> ⚠️ 在 Actions 页面**手动触发** `workflow_dispatch` 只做构建验证，
> **不会**创建 Release、也不会发布更新清单 —— 更新源只跟随正式 tag。

### 发布所需 Secrets

在仓库 `Settings → Secrets and variables → Actions` 中配置：

| Secret | 用途 |
|---|---|
| `VITE_CLOUD_ENDPOINT` | 云端接口地址（缺失会导致构建出连不上后端的包） |
| `VITE_CLOUD_KEY` | 云端应用标识 |
| `TAURI_SIGNING_PRIVATE_KEY` | 更新包签名私钥 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 上述私钥的密码 |

macOS 正式签名与公证（可选，配置后用户双击即开、零提示）：

| Secret | 用途 |
|---|---|
| `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD` | Developer ID 证书（base64） |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | 公证凭据 |

> 🔐 **私钥务必离线备份。** 更新包签名私钥一旦丢失，就再也无法签发更新，
> 所有已安装的客户端只能手动重装。

## 下载安装

前往 [Releases](../../releases/latest) 页面：

- **Windows**：下载 `QuickNote_x.x.x_x64-setup.exe`
- **macOS（Apple Silicon）**：下载 `QuickNote_x.x.x_aarch64.dmg`

已安装的旧版本会在启动后自动检查并提示更新，无需重复下载。

## 安全说明

- 所有数据访问均需**登录公司邮箱**，数据库行级权限策略（RLS）按邮箱域名校验，
  未登录或域名不符的请求读不到任何数据。
- 前端持有的云端参数属于**应用标识**（用于标识调用方），真正的数据边界在服务端权限策略。
- 更新包在安装前由 Rust 侧用内置公钥校验签名，防止被替换为伪造安装包。

## 许可证

本项目基于 [MIT License](./LICENSE) 开源。
