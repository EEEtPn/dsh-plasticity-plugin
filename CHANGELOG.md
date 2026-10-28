# Changelog

本文件记录本插件的所有重要变更，格式参考 [Keep a Changelog](https://keepachangelog.com/)，
版本号遵循 [SemVer](https://semver.org/)。

## [0.2.0] - 2026-10-28

### Added
- 标准化为可发布的 DSH 插件包：`docs/`、`test/`（无需 Plasticity 的 mock 宿主测试）、`scripts/pack.mjs`、`scripts/verify-live.mjs`、`LICENSE`、`.gitignore`。
- `lib/*.mjs` 统一为 `lib/*.js`（包 `"type": "module"`），`bridge.mjs → protocol.js`。
- `package.json` 增加 `repository` / `homepage` / `bugs` / `author` / `engines.dsh` / `scripts`。
- `examples/plate-with-hole.step` 示例件与 README 截图。

### Changed
- 工具数量 16（新增 `plasticity_view` 相机取景、`plasticity_shutdown` 关闭实例）。
- `plasticity_scene` 文本回执直接带 edges / faces 摘要（前 12 条边 / 10 个面）。
- `plasticity_export` / `plasticity_screenshot` 相对路径按会话工作区解析（`exec.agent.session.header.cwd`）。
- 截图前默认发送 Escape，关闭 Plasticity 半开着的工具浮窗。

### Fixed
- 隔离实例不再改写共享崩溃恢复文档 `%TEMP%\plasticity\backup.production.plasticity`
  （私有 TEMP + 启动前快照，并在启动后等待恢复文档加载稳定）。

## [0.1.1] - 2026-10-27

### Added
- `locale/en.json`、`locale/zh.json`、`icon.svg`：插件页显示元数据与图标。
- 以 tarball 安装（`plugin_manager install_bundle`）替代 `link:`：规避 Windows junction 被判
  "untrusted mount point" 的问题。

### Fixed
- 启动失败进安全模式的问题：移除 profile `node_modules` 中的 mock 包、不再使用 `link:` 依赖。

## [0.1.0] - 2026-10-26

### Added
- 首个可用版本：Electron CDP 桥（`--inspect-brk` 注入回环调试端口 → `Runtime.queryObjects` 发现 Editor →
  按名字解析工厂）+ 14 个工具（状态/启动/场景/测量/盒柱球/拉伸/布尔/圆角/变换/删除/历史/导出/截图/脚本）。
- 端到端实测：60×40×20 板 + Ø12 通孔 + Ø16 凸台 + 四角 R5，体积 46822 mm³，STEP/STL 导出通过。
