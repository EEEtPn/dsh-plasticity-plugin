# 架构与实现原理

## 0. 一句话

DSH 工具 → 插件（Node 主进程）→ **回环 CDP**（127.0.0.1:9223）→ Plasticity 渲染进程里的 `Editor` 实例 →
Plasticity 自己的 `command` / `*Factory` 管线 → 原生 Parasolid B-rep。

## 1. 为什么要自建 CDP 桥

Plasticity 是 Electron 应用，官方**没有**脚本 API / MCP。但它有两个可利用的事实：

1. 主进程的 Electron fuse `EnableNodeCliInspectArguments` 是**开启**的（26.1.3 实测）。
2. 渲染进程里有一个全局唯一的 `Editor` 实例，暴露 182 个命令与约 250 个 `*Factory` 构造函数。

于是：用 `--inspect-brk` 把主进程停在第一个 JS 断点，在断点里给 `app.commandLine` 打补丁，
让渲染进程开一个**只监听 127.0.0.1 的 DevTools 端口**；随后所有操作都通过 CDP 在渲染进程里执行。

不修改磁盘文件、不重签名、不 patch 应用。

## 2. 启动链（lib/protocol.js）

```
spawn Plasticity.exe --inspect-brk=127.0.0.1:9229
  └─ 等 /json/list 出现 node target
     └─ Debugger.enable + Runtime.runIfWaitingForDebugger
        └─ 在 Debugger.paused 的 callFrame 上 evaluateOnCallFrame：
             app.commandLine.removeSwitch 劫持（放行 remote-debugging-port）
             app.commandLine.appendSwitch('remote-debugging-address','127.0.0.1')
             app.commandLine.appendSwitch('remote-debugging-port','9223')
           └─ Debugger.resume
              └─ 等 http://127.0.0.1:9223/json/list 出现 page（url 含 /renderer/app_window/index.html）
```

关键细节：

- `ELECTRON_RUN_AS_NODE=1` 必须从子进程环境里删掉，否则 `Plasticity.exe` 会被当成 Node 运行；
- 隔离启动（`isolated:true`）使用独立 `--user-data-dir` **和私有 TEMP**（见第 6 节）；
- 主进程补丁必须在 `app.ready` **之前**执行，否则 `--remote-debugging-port` 会被忽略。

## 3. 渲染进程里的对象发现（lib/session.js）

```
Runtime.evaluate("Function.prototype")        → objectId
Runtime.queryObjects(prototypeObjectId)       → 堆里所有函数
  └─ 筛出 name === 'Editor' 且 prototype 有 open/save/exec
     └─ Runtime.queryObjects(Editor.prototype) → 唯一 Editor 实例
```

拿到 `editorId` 之后：

- **命令**：`editor.commands.XxxCommand` 直接取（无需发现），共 182 个；
- **工厂**：在函数堆里按名字筛（`ThreePointBoxFactory` / `CylinderFactory` / `BooleanFactory` …）；
- **Vector3 / Quaternion / Matrix4**：从 `editor.viewports[0].camera.position.constructor` 取；
- **store**：`editor.geo.geometryModel` 是 `Map<versionId, {view, model}>`；对外的 body id =
  `editor.db.lookupStableId(versionId)`（每次 rebuild 会变的是内部 versionId）。

`window.__plasticity` 里注入一个 bootstrap shim（`api.geo` / `api.db` / `api.selection`），
避免每个操作都重新探测 store 形状。

> 本机 26.1.3 是**扁平 store**（`geo.geometryModel` 直挂，没有 `geo.read`）。代码同时兼容两种形态。

## 4. 执行模型：为什么必须走 command

```js
const command = new editor.commands.CylinderCommand(editor);
command.remember = false;
command.execute = async function () {
  const factory = new CylinderFactory(editor).resource(this);
  // ... 赋值 ...
  return await factory.commit();
};
await editor.exec(command);
```

- `editor.exec(command)` 是 Plasticity 自己的命令执行器（和点 UI 按钮同一条路径）；
- 因此会进 **Undo 历史**、会触发自动重建与视口刷新；
- 直接 `factory.commit()` 而不包命令会绕过执行器，Undo / 刷新可能不对；
- 参数顺序：`new Factory(editor)` 然后 `.resource(this)`（`this` = command 实例）。

## 5. 数据流与单位

- 工具边界：**mm / 度**；页面端 `toM(v) = v / 1000`；
- 测量：`collection.EvaluateMassProperties()` → `amounts`（体积 m³）/ `peripheries`（面积 m²），
  乘 1e9 / 1e6 转 mm³ / mm²；包围盒用 `model.FindBox()`（米）；
- 导出：`ExportCadFactory`（STEP）/ `STLExportFactory` / `ThreeMfExportFactory` / `OBJExportFactory`，
  容差字段是米；路径由 **Plasticity 进程**解析，所以用绝对路径或会话工作区解析后的路径。

## 6. 隔离与共享状态

- `isolated:true`：独立 `--user-data-dir`（避开单实例锁），并把子进程 `TEMP/TMP` 指向私有目录 ——
  因为 Plasticity 的崩溃恢复文档写在**固定** `%TEMP%\plasticity\backup.production.plasticity`，
  `--user-data-dir` 不覆盖它；
- 启动前快照该恢复文档（回执里的 `recoveryBackup`），启动后等待恢复文档加载稳定
  （document + body 集合连续两次一致）再返回，避免读/写空文档竞态。

## 7. 串行化与失败语义

- 所有工具调用经一个 Promise 队列串行执行（Plasticity 命令执行器本身不允许并发命令）；
- 超时/连接中断后，几何结果可能不确定：不要无脑重试，先 `plasticity_scene` 重读场景；
- `plasticity_script` 是唯一不保证语义的入口（执行任意渲染端 JS）。

## 8. 目录结构

```
lib/index.js     插件入口：注入注入 (inject: ['tools'])、16 个 defineTool、结果消毒、串行队列
lib/protocol.js  CDP 客户端、Plasticity 启动/补丁、target 发现、截图
lib/session.js   Editor 发现、工厂/Vector/Quaternion 解析、bootstrap shim、调用封装
lib/ops.js       页面端 CAD 操作实现（场景/测量/建模/布尔/圆角/变换/导出/相机）
```

## 9. 已知边界

- 版本绑定：命令/工厂名按 26.1.3 锁定；
- 体积质心需要 kernel 命名空间（本机双候选，主动绕开）；
- 未实现：草图约束、曲面放样/扫掠、装配 mate（可通过 `plasticity_script` 自行扩展）。
