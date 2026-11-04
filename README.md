# GH Artifact Proxy

粘贴一个 GitHub Actions **Workflow Run 链接**，即刻列出这次构建产生的全部 Artifact，并通过加速线路下载。无需安装、无需登录、打开网页即用。

> **在线使用：https://lindedaoqwq.github.io/gh-artifact-proxy/**

---

## 三步开始

1. 在 GitHub 打开某次 Actions 运行页面，复制地址栏链接，形如
   `https://github.com/owner/repo/actions/runs/1234567890`
2. 粘贴进页面输入框，点「解析」（**粘贴完整链接也会自动开始解析**）
3. 在 Artifact 列表中点「下载」，或点「复制链接」交给下载工具

不知道填什么？点输入框下方的**快捷示例**可以直接体验。

## 支持哪些链接

| 可以直接粘贴 | 示例 |
| --- | --- |
| 完整 Run 链接 | `https://github.com/owner/repo/actions/runs/1234567890` |
| 省略 `https://` | `github.com/owner/repo/actions/runs/1234567890` |
| API 形式的链接 | `https://api.github.com/repos/owner/repo/actions/runs/1234567890` |
| 简写 | `owner/repo/1234567890` |

链接后面带参数（如 `?check_suite_focus=true`）也能识别。

## 页面上能看到什么

- **本次运行**：状态（成功 / 失败 / 进行中）、工作流名称、分支、提交、触发方式、Run 编号
- **每个 Artifact**：名称、大小、创建时间、过期时间，以及是否**已过期**（过期的会置灰且无法下载）
- **API 剩余额度**：页脚显示剩余次数与重置时间

## 下载怎么选

绝大多数情况**不需要任何设置**：保持默认即可，页面会自动测速并从 5 条加速线路中选用延迟最低的一条。

| 场景 | 怎么做 |
| --- | --- |
| 公有仓库，正常下载 | 默认即可，点「下载」 |
| 想用下载工具 / 命令行 | 点「复制链接」，例如 `wget -O artifact.zip "<链接>"` |
| 下载慢或某条线路失效 | 「高级选项 → 下载代理」手动换一条线路，或点「重新测速」 |
| 私有仓库 | 「高级选项」填写 GitHub Token（见下） |
| 网络打不开 `api.github.com` | 开启「API 请求也走代理」（仅公有仓库，且不要填 Token） |

所有加速线路均来自 [gh-proxy.com](https://gh-proxy.com)，默认「自动选择最快线路」会对每条线路连续测速 5 次取平均值，结果比单次测速更稳定；也可以手动指定 `gh-proxy.org` / `v4` / `v6` / `cdn` / `axisnow` 任一线路，或填写自己的代理地址。

## 关于 Token（只有两种情况需要）

**私有仓库**，或**匿名额度不够用**时才需要填写。匿名访问 GitHub API 限制为 60 次/小时，填写 Token 后提升到 5000 次/小时。

- 在 GitHub → Settings → Developer settings → Personal access tokens 生成，需具备 `repo` 权限（或对应仓库的 Actions 读取权限）
- 支持 `ghp_…` 与细粒度的 `github_pat_…`
- Token **只保存在你自己的浏览器里**，请求直接发往 `api.github.com`，**不会经过任何代理服务器**；开启「API 走代理」时页面会强制禁止携带 Token，避免泄露
- 用完可点「清除」随时删除

> 填写 Token 后，下载改为浏览器直连并带**实时进度条**，可随时取消。

## 常见问题

**提示「未找到对应的 Run（404）」？**
链接写错、该 Run 已被删除，或仓库是私有的但没填 Token——这三者都会返回 404，逐一排查即可。

**提示「API 额度已用尽」？**
匿名额度（60 次/小时）用完了，页面会显示重置时间。填一个 Token 即可提升到 5000 次/小时，或等重置后再试。

**Artifact 显示「已过期」，还能下吗？**
不能。GitHub 会定期清理过期的 Artifact（默认保留期由仓库设置决定，通常为 90 天），过期后源文件已不存在，任何工具都下载不了。

**列表能读出来，但下载没反应 / 很慢？**
在「高级选项 → 下载代理」换个线路，或点「重新测速」；也可以改用「复制链接」交给 wget、IDM 等工具断点续传。

**我的数据会被收集吗？**
不会。这是纯静态页面，**没有任何服务端**，所有请求都由你的浏览器直接发向 GitHub 或你所选的线路；页面不上传、不存储任何使用数据，Token 与设置只存在本机浏览器。

**手机上能用吗？**
可以，页面做了响应式适配。

---

## 自己部署一份（可选）

> 以下内容仅在你希望搭建自己的副本时才需要阅读，普通用户直接访问上方在线地址即可。

站点是零依赖、零构建的纯静态页面（`index.html` / `style.css` / `app.js`），可直接丢到任意静态托管。部署到 GitHub Pages：

1. Fork 本仓库并推送到 `main`；
2. **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**（仓库已内置 `.github/workflows/deploy.yml`，之后每次推送自动部署）；
3. 访问 `https://<你的用户名>.github.io/gh-artifact-proxy/`。

本地预览：`python3 -m http.server 8080` 后打开 `http://localhost:8080`。

想改动：仓库链接在 `app.js` 的 `CONFIG.repoUrl`，加速线路在 `PROXIES` 数组；文件说明见仓库内源码注释。

## License

[MIT](./LICENSE)
