# 故障排查

## 0. 先看三处

| 看什么 | 路径 / 方法 |
|---|---|
| DSH 启动日志（插件是否注册） | host 启动输出里的 `[dsh-plasticity-plugin] v… registered N tools` |
| DSH 崩溃日志 | `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log` |
| 桥是否通 | 调 `plasticity_status`；或 `curl http://127.0.0.1:9223/json/list` |

## 1. 工具列表里没有 `plasticity_*`

按顺序排查：

1. **bundle 是否装且启用**：`profile\package.json` 的 `dsh.profile.bundles` 里要有 `dsh-plasticity-plugin`；
   插件页显示「未安装」说明是手工拷目录而不是插件管理器装的 → 用 tarball 重装（见 [INSTALL.md](INSTALL.md)）。
2. **插件 import 是否失败**：启动日志有没有 `registered 16 tools`；没有就看 crash log 里
   `Failed plugins` / `failed to import`。
3. **profile 里有没有同名 mock 包**：`node_modules\@deepseek-ai\dsh-tools` 存在会挡住核心 `tools` 插件，
   直接导致启动失败进安全模式 —— 删掉它。
4. **上次是安全模式启动**：安全模式会把 bundles 裁到最小；恢复 bundles 后完全退出重开。

## 2. Startup 失败 / 自动进安全模式

典型日志：

```
Failed plugins (1): tools   Package: @deepseek-ai/dsh-tools   failed to import
```

处理：

1. 删掉 `node_modules\@deepseek-ai\dsh-tools`（mock/残留）；
2. 确认 `dependencies` 里没有 `link:` 指向不可读目录的条目；
3. 完全退出 DSH，重开；
4. 仍失败 → 回滚 profile（恢复安装前 `package.json`、删除插件目录），再逐个重装插件定位。

## 3. `Plasticity is not reachable on 127.0.0.1:9223`

- 还没启动：调 `plasticity_launch`；
- 已启动但不是通过桥启动（没有调试端口）：退出 Plasticity，再用 `plasticity_launch {isolated:false}`；
- 端口被占：`plasticity_launch {rendererPort: 9224}`（同时改 `PLASTICITY_CDP_PORT` 供其它脚本用）。

## 4. 启动后崩溃/退出码 9 / `bad option: --user-data-dir`

`ELECTRON_RUN_AS_NODE=1` 被继承给了 Plasticity 子进程 → 它被当成 Node 跑。
插件已在 spawn 时删除该变量；自己写脚本时也要删。

## 5. `Plasticity main process never paused at startup`

- 已有实例占着 inspector 端口（9229）：先关掉/杀掉，或换端口；
- 启动参数被 Squirrel stub 吞掉：必须直接启动 `app-<ver>\Plasticity.exe`（插件自动找）；
- Plasticity 版本改了 fuse 策略（见第 8 条）。

## 6. `Plasticity is busy`

Plasticity 命令执行器在忙（上一条命令未结束，或有模态工具浮窗）。
稍等重试；`plasticity_screenshot` 会先发 Escape 关闭浮窗。

## 7. 几何/体积不对

- 布尔只有相**交叠**才有效果（相切/共面不算交叠）；
- 圆角半径过大 → native 报错（错误信息里带 Parasolid 码）；
- 轮廓拉伸要求闭合且逆时针（插件自动补 CCW）；自交多边形会失败；
- 用 `plasticity_measure` 看 `nativeCheckCodes`：非空说明 B-rep 有问题。

## 8. Plasticity 升级之后

本插件按 **26.1.3** 的命令/工厂名编写。升级后可能出现：

| 症状 | 处理 |
|---|---|
| `Plasticity class not found` | 更新 `lib/ops.js` 里对应 factory 的候选名数组 |
| `Plasticity Editor prototype is missing or ambiguous` | 检查 `lib/session.js` 的 discovery 谓词（store 形状可能变） |
| `Plasticity rejected the loopback CDP startup hook` | 新版在 `app.ready` 前禁止改 commandLine，需要重新评估注入时机 |
| fuse 关闭 | `npm run verify -- --fuse-only` 确认；关闭则本方案不可用 |

## 9. 共享恢复文档被测试覆盖

Plasticity 把崩溃恢复副本写到固定 `%TEMP%\plasticity\backup.production.plasticity`（`--user-data-dir` 不覆盖）。
做破坏性几何测试请用 `plasticity_launch {isolated:true}`（插件会私有 TEMP + 启动前快照）。
若已被覆盖：快照在隔离实例的 `recovery/` 目录里（启动回执的 `recoveryBackup` 字段）；否则只能从你自己的备份恢复。

## 10. 收集现场

```powershell
# 插件是否加载
Select-String -Path <dsH-startup-log> -Pattern "dsh-plasticity-plugin"
# 崩溃
Get-ChildItem "$env:APPDATA\@deepseek-ai\dsh-desktop\logs" | Sort-Object LastWriteTime -Descending | Select-Object -First 3
# CDP
Invoke-WebRequest http://127.0.0.1:9223/json/list -UseBasicParsing
# 进程
Get-CimInstance Win32_Process -Filter "Name='Plasticity.exe'" | Select-Object ProcessId,CommandLine
```
