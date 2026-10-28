# 安装 / 卸载 / 回滚

> 适用平台：Windows 10/11 x64 + Plasticity **26.1.3** + DSH Desktop（`>= 0.1.0-rc.7`）。
> 下文 `<ver>` 指 `package.json` 的 `version`（当前 `0.2.0`）。

## 0. 前提检查

1. Plasticity 26.1.3 已安装，路径形如 `%LOCALAPPDATA%\Plasticity\app-26.1.3\Plasticity.exe`
   （Squirrel 布局：顶层目录是更新 stub，插件会自己找 `app-<ver>` 目录）。
2. Plasticity 的 `EnableNodeCliInspectArguments` fuse 为开启（官方 26.1.3 默认开启）。
   自检：

   ```powershell
   npm run verify -- --fuse-only
   ```

3. DSH 能正常启动（插件列表可打开）。

## 1. 推荐安装：tarball（plugin_manager）

为什么不用 `link:` / 手工拷目录：

- 本机 DSH 的 shell 进程创建 Windows junction 会被标记为 *untrusted mount point*，pnpm 自己都读不了；
- 手工把包目录拷进 `node_modules` 虽然能加载，但插件页按 manifest 判定，会显示成「未安装」；
- tarball 会被 pnpm **解包成真实目录**，不产生链接，最稳。

```powershell
# 1) 打包（产物默认在当前目录，可用 npm run pack -- --out <dir> 指定）
npm run pack

# 2) 在 DSH 会话里执行（plugin_manager 会写 profile 的 dependencies，
#    并保留 dsh.profile.bundles 里的 bundle 条目）
#    plugin_manager install_bundle target="C:\...\dsh-plasticity-plugin-0.2.0.tgz"

# 3) 看回执：application:"applied" 才算生效；version 变化后需完全重启 DSH Desktop
```

重启后自检：DSH host 启动日志应出现

```
[dsh-plasticity-plugin] v0.2.0 registered 16 tools
```

然后让 AI 调 `plasticity_status`。

## 2. 从 GitHub 安装

若 DSH 的插件管理器支持 git 源：

```
plugin_manager install_bundle target="https://github.com/EEEtPn/dsh-plasticity-plugin"
```

## 3. 开发时手工安装（不推荐长期使用）

```powershell
$src = "<repo>"
$profile = "$env:USERPROFILE\.dsh\profiles\desktop"
# 目录拷贝（真实目录，不走 pnpm）
New-Item -ItemType Directory -Force "$profile\node_modules\dsh-plasticity-plugin" | Out-Null
robocopy $src "$profile\node_modules\dsh-plasticity-plugin" /E /NFL /NDL /NJH /NJS /NP | Out-Null
```

并在 `$profile\package.json` 的 `dsh.profile.bundles` 里加入 `"dsh-plasticity-plugin"`。
> 注意：这样加载能生效，但插件页会显示「未安装」（没有 dependencies 记录）。

## 4. 卸载

在 DSH 的插件管理里卸载该 bundle（会从 `dsh.profile.bundles` 与 `dependencies` 移除），
然后删除 `node_modules\dsh-plasticity-plugin`，完全重启 DSH。

## 5. 回滚到无插件状态

```powershell
# 删除 bundle 条目 + 包目录后重启即可。若 profile 已被改坏：
#   - 恢复备份的 package.json（安装前备份）
#   - 删除 node_modules\dsh-plasticity-plugin
#   - 确认 node_modules\@deepseek-ai 下没有 mock 包
```

## 6. 常见安装错误

| 现象 | 原因 | 处理 |
|---|---|---|
| 插件页显示「未安装」 | 手工拷贝目录，无 dependencies 记录 | 改用 tarball 安装 |
| `UNKNOWN: unknown error, open '...\node_modules\dsh-plasticity-plugin\package.json'` | pnpm 建的 junction 被判 untrusted | 不要用 `link:`；改 tarball |
| 启动进安全模式，日志 `tools ... failed to import` | profile `node_modules` 里存在同名 mock 包（如 `@deepseek-ai/dsh-tools`） | 删掉该目录后重启 |
| 工具列表里没有 `plasticity_*` | bundle 没装/没启用，或插件 import 失败 | 看 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` |

更多见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md)。
