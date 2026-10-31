# GH Artifact Proxy

输入 GitHub Actions Workflow Run 链接，即可读取该 Run 的 Artifact 列表，并通过 gh-proxy.com 提供的加速线路**加速下载**。纯静态页面、零依赖、零构建，可直接部署到 GitHub Pages。

## 功能特性

- **链接解析**：支持 `https://github.com/owner/repo/actions/runs/<id>`、`owner/repo/<id>`、`api.github.com/repos/…` 等多种格式，粘贴完整链接自动开始解析
- **信息读取**：展示 Run 状态、工作流、分支、提交、触发方式，以及每个 Artifact 的名称、大小、创建与过期时间
- **加速下载**：
  - 公有仓库：下载链接经 gh-proxy.com 提供的加速线路前缀转发（默认自动测速选最快，亦可手动指定某条线路）
  - 私有仓库：填写 Token 后由浏览器直连 Azure CDN 下载，带**实时进度条**，可取消
- **多代理切换**：内置 gh-proxy.com 全部 5 条加速线路，支持「自动选择最快线路」实时测速优选，亦可手动指定或自定义代理，一键复制加速链接给 wget / curl 使用
- **Token 管理**：Token 仅存浏览器 localStorage，直接请求 api.github.com，**不经过任何代理**；开启「API 走代理」时强制禁止携带 Token
- **弱网兼容**：无法直接访问 api.github.com 时，可开启「API 请求也走代理」（仅公有仓库）
- **实用细节**：API 限额显示与重置时间提示、404/403/限流等错误的明确指引、响应式浅色 UI

## 本地预览

无需构建，任选其一：

```bash
# 方式一：直接用浏览器打开
open index.html        # macOS
xdg-open index.html    # Linux

# 方式二：起一个本地服务（推荐，行为与线上一致）
python3 -m http.server 8080
# 访问 http://localhost:8080
```

## 部署到 GitHub Pages

仓库名建议为 `gh-artifact-proxy`，两种方式任选：

### 方式一：GitHub Actions 自动部署（推荐）

1. 将本仓库推送到 GitHub 的 `main` 分支；
2. 进入 **Settings → Pages → Build and deployment → Source**，选择 **GitHub Actions**；
3. 之后每次推送 `main` 都会自动部署（已内置 `.github/workflows/deploy.yml`）；
4. 访问 `https://<你的用户名>.github.io/gh-artifact-proxy/`。

### 方式二：分支部署

1. 推送代码到 `gh-pages` 分支（或使用 main 分支根目录）；
2. **Settings → Pages → Source** 选择 **Deploy from a branch**，分支选 `gh-pages`，目录选 `/ (root)`。

> 已附带 `.nojekyll`，可避免下划线开头的文件被 Jekyll 忽略。

## 使用说明

1. 打开某个 Workflow Run 页面（如 `https://github.com/owner/repo/actions/runs/1234567890`），复制地址栏链接；
2. 粘贴到输入框，点击「解析」；
3. 在 Artifact 列表中：
   - 点击「下载」直接下载；
   - 点击「复制链接」得到加速链接，可配合 `wget -O artifact.zip "<链接>"` 或 IDM 等工具使用。

**私有仓库**：在「高级选项」中填写具备 `repo` 权限的 Token（`ghp_…` 或 fine-grained `github_pat_…`），即可读取列表并直连下载。

## 代理说明

所有加速线路均来自 [gh-proxy.com](https://gh-proxy.com)，仅用于加速 GitHub 资源（Release / Raw / Archive / API）。默认「自动选择最快线路」会实时测速并选用延迟最低的节点：

| 线路 | 说明 |
| --- | --- |
| 自动选择最快线路（默认） | 启动时对各线路发起测速，自动选用延迟最低的节点 |
| `gh-proxy.org`（Cloudflare） | gh-proxy.com 主线路 |
| `v4.gh-proxy.org`（Cloudflare 推荐） | Cloudflare 优选线路 |
| `v6.gh-proxy.org`（Cloudflare v4/v6） | 支持双栈 |
| `cdn.gh-proxy.org`（Fastly） | Fastly CDN 线路 |
| `axisnow.gh-proxy.org`（AxisNow） | AxisNow 线路 |

可在页面「高级选项 → 下载代理」中切换线路、点击「重新测速」刷新延迟，或填写自定义代理地址（格式 `https://域名/`，拼接规则为「前缀 + 完整原始 URL」）。

## 安全与隐私

- 本页面为纯静态站点，**没有任何服务端**，所有请求均由浏览器直接发向 api.github.com 或所选代理；
- Token 仅保存在浏览器 localStorage，不会发送到代理服务器（开启「API 走代理」时禁止携带 Token）；
- 不收集、不存储任何用户数据。

## 文件结构

```
├── index.html                  # 页面结构
├── style.css                   # 样式（浅色主题，参考 gh-proxy.com）
├── app.js                      # 全部交互逻辑（无依赖）
├── .github/workflows/deploy.yml# GitHub Pages 自动部署
├── .nojekyll
├── LICENSE
└── README.md
```

## 自定义

- 修改右上角仓库链接：编辑 `app.js` 顶部的 `CONFIG.repoUrl`；
- 增删代理：编辑 `app.js` 顶部的 `PROXIES` 数组。

## License

[MIT](./LICENSE)
