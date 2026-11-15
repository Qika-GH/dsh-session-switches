# 发布说明（GitHub / npm / 插件市场）

三种交付路径互相独立，可以只走其中一种：

| 路径 | 别人怎么装 | 需要什么 |
|---|---|---|
| Git 直装 | `dsh plugin --profile <p> add "git+https://github.com/Qika-GH/dsh-session-switches.git#<commit>"` | 一个公开仓库 |
| npm | `dsh plugin --profile <p> add dsh-session-switches@0.1.0` | npm 账号（registry 必须是 npmjs.com） |
| 插件市场（Discover） | 市场 → 源 → 添加索引地址 → 搜索 → 安装 | 一个公开可访问的 format 1 索引 JSON |

社区总目录（awesome-dsh-plugin）是第四件事：它只把插件**列出来**，安装仍走上面三条。

## 本机实测（2026-11-15，Qika-GH 的 Windows 机器）

这台机器到 GitHub 的 **HTTPS 是不通的**：`github.com:443` 在 TLS 握手阶段被重置，
curl 拿 `000`；`api.github.com` 直接连不上；全局还配了一条
`url.https://ghfast.top/https://github.com/.insteadOf https://github.com/`，
会把所有 https 流量绕到镜像（该镜像对本仓库返回 403）。

**SSH 通**（`github.com:22` 正常），所以推送走 SSH，remote 用 scp 形式（不会被上面那条重写命中）：

```bash
git remote add origin git@github.com:Qika-GH/dsh-session-switches.git
git config core.sshCommand '"C:/Program Files/Git/usr/bin/ssh.exe" -o StrictHostKeyChecking=accept-new'
GIT_SSH_COMMAND='"C:/Program Files/Git/usr/bin/ssh.exe"' git push -u origin main
```

凭据助手（Git Credential Manager）在 `C:/Program Files/Git/ucrt64/bin/git-credential-manager.exe`
（注意是 `ucrt64` 不是 `mingw64`）。git 不接受把路径直接塞进 `credential.helper`（会被当成命令名，
报 `git: 'credential-C:/Program Files/...' is not a git command`），必须用 shell 形式：

```bash
git config --global credential.helper '!"C:/Program Files/Git/ucrt64/bin/git-credential-manager.exe"'
```

公开性验证一条命令即可（本机实测三项全绿）：

```bash
scripts/check-visibility.sh Qika-GH dsh-session-switches main
# github.com/...      -> HTTP 200 (public)
# anonymous git ls-remote -> ok
# jsDelivr @main/market/index.json -> HTTP 200
```

## 0. 替换占位符

所有者已经写死为 `Qika-GH`。若以后要换账号，一条命令替换：


```bash
grep -rl Qika-GH . --exclude-dir=node_modules --exclude-dir=.git \
  | xargs sed -i 's/Qika-GH/<你的用户名>/g'
```

## 1. 推到 GitHub

```bash
cd dsh-session-switches
git init -b main
git add -A
git commit -m "feat: per-conversation plugin switches for the DSH sidebar"
git remote add origin https://github.com/Qika-GH/dsh-session-switches.git
git push -u origin main
```

仓库建好后在网页上做两件事：

1. **Settings → Topics** 加 `dsh-plugin`（社区目录会看这个 topic）。
2. 打一个 `v0.1.0` 的 tag / Release，和 `package.json` 的版本一致。

推送需要凭据：本机没有 `gh`，也没有 `~/.git-credentials`。用 Personal Access Token 或让 Git 凭据管理器弹窗登录。

## 2. 发到 npm

```bash
npm config set registry https://registry.npmjs.org   # 本机默认是 npmmirror 镜像，镜像不能发布
npm login
npm publish --access public
npm view dsh-session-switches version dist.tarball
```

发布前 `npm pack --dry-run` 看一眼打包内容：`files` 里列了 src / lib / scripts / locale / docs / cordis.patch.yml / README.md，别把 test 与截图带进去（当前 `files` 没列 test，符合）。

## 3. 自托管一个插件市场索引

`market/index.json` 已按 format 1 写好（`source.type = git`，带 40 位 commit）。发版时改三处：`version`、`publishTimestamp`（Unix 秒）、`commit`（`git rev-parse HEAD`）。

索引和图标一起放任意静态托管即可：

- GitHub Pages：`https://Qika-GH.github.io/dsh-session-switches/index.json`
- jsDelivr 直读仓库：`https://cdn.jsdelivr.net/gh/Qika-GH/dsh-session-switches@main/market/index.json`

别人那边：**插件 → 实验性插件 → 打开「自定义插件索引」→ 发现 → 添加索引源**，粘贴地址即可搜索、一键安装。

> jsDelivr 对 `@main` 有缓存；发版后用 `@v0.1.0` 这种 tag 地址更稳。

## 4. 收进社区总目录

社区目录源：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`，由 [awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 生成，数据在 `data/plugins/`，一个插件一个 YAML。

条目已备好：`market/community-entry.yml`。

```bash
git clone https://github.com/<你>/awesome-dsh-plugin.git && cd awesome-dsh-plugin
cp <本包>/market/community-entry.yml data/plugins/Qika-GH__dsh-session-switches.yml
git checkout -b add-session-switches
git add data/plugins/Qika-GH__dsh-session-switches.yml
git commit -m "Add Qika-GH/dsh-session-switches"
git push -u origin add-session-switches
```

然后去 GitHub 提 PR。CI 会检查仓库年龄，刚建的仓库可能被拦一次，等功能与文档补齐后重提即可。

## 5. 发版检查清单

| # | 检查 | 命令 |
|---|---|---|
| 1 | 客户端 bundle 与源码一致 | `npm run build` 后 `git status` 不应出现 `lib/client/index.js` |
| 2 | 自测通过 | `npm test` |
| 3 | 版本一致 | `package.json` / `market/index.json` / git tag 三处同号 |
| 4 | 打包内容干净 | `npm pack --dry-run` |
| 5 | 索引能解析 | 用 DSH 的 `parseMarketIndex` 校验 `market/index.json` |
| 6 | 干净 profile 能装 | `dsh plugin --profile <新 p> add "git+…#<commit>"` 后插件出现在列表里 |
