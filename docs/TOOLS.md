# 工具参考（自动生成）

> 本文件由 `scripts/gen-tools-docs.mjs` 从 `lib/index.js` 的工具定义生成，请勿手工编辑。
> 全部参数在 DSH 侧使用 **mm / 度**；`id` 一律来自 `plasticity_scene`。

共 16 个工具。

## `plasticity_boolean`

Boolean between native solids: operation=union|difference|intersection. targetIds are modified, toolIds are consumed unless keepTools=true. Returns the resulting bodies.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `operation` | enum(union | difference | intersection) | 是 | Boolean operation. |
| `targetIds` | array<string> | 是 | Target body ids. |
| `toolIds` | array<string> | 是 | Tool body ids. |
| `keepTools` | boolean |  | Keep the tool bodies after the boolean (default false). |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 240000 ms。

## `plasticity_create`

Create a native solid primitive in the active document: kind=box (originMm corner + sizeMm), cylinder (centerMm = base center, radiusMm, heightMm, optional axis), sphere (centerMm + radiusMm). All units mm; results are real Parasolid solids and land in Undo history.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `kind` | enum(box | cylinder | sphere) | 是 | Primitive kind. |
| `originMm` | array<number> |  | Box corner (mm) [x,y,z]. |
| `sizeMm` | array<number> |  | Box size (mm) [x,y,z]. |
| `centerMm` | array<number> |  | Cylinder base center / sphere center (mm). |
| `radiusMm` | number |  | Cylinder / sphere radius (mm). |
| `heightMm` | number |  | Cylinder height (mm). |
| `axis` | array<number> |  | Cylinder axis (default [0,0,1]). |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 180000 ms。

## `plasticity_delete`

Delete native bodies by id (undoable).

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ids` | array<string> | 是 | Body ids to delete. |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 120000 ms。

## `plasticity_export`

Export native geometry to disk next to the workspace: format=step (B-rep CAD interchange, .step/.stp), stl, 3mf or obj (mesh, tessellated with mm tolerances). Omit ids to export every solid/sheet. Returns the absolute output path and byte size.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `format` | enum(step | stl | 3mf | obj) | 是 | Export format. |
| `path` | string |  | Output path (absolute or relative to the workspace). Default: .dsh-plasticity/exports/<timestamp>.<ext>. |
| `ids` | array<string> |  | Body ids; omit for all solids/sheets. |
| `chordToleranceMm` | number |  | Mesh chord tolerance in mm (default 0.05). |
| `angleToleranceDegrees` | number |  | Mesh angle tolerance in degrees (default 5). |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 300000 ms。

## `plasticity_extrude`

Extrude native geometry. Mode A: pass bodyId + faceIds (from plasticity_scene) to push/pull faces. Mode B: pass pointsMm (closed polygon, mm, on the XY plane at planeZMm) and the tool builds the polyline, reuses the native region and extrudes it into a solid. distanceMm may be negative.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `bodyId` | string |  | Body whose faces are extruded (mode A). |
| `faceIds` | array<string> |  | Face ids to extrude (mode A). |
| `pointsMm` | json |  | Closed polygon [[x,y],...] in mm (mode B). |
| `planeZMm` | number |  | Z height of the sketch plane (mode B, default 0). |
| `distanceMm` | number | 是 | Extrude distance (mm); negative extrudes the other way. |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 240000 ms。

## `plasticity_fillet`

Round or chamfer native edges of one body: distanceMm > 0 with chamfer=false gives a fillet; chamfer=true gives a chamfer. edgeIds come from plasticity_scene; all edges must belong to bodyId.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `bodyId` | string | 是 | Body that owns the edges. |
| `edgeIds` | array<string> | 是 | Edge ids from plasticity_scene. |
| `distanceMm` | number | 是 | Fillet radius / chamfer distance in mm. |
| `chamfer` | boolean |  | true = chamfer, false (default) = fillet. |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 240000 ms。

## `plasticity_history`

Undo or redo the last Plasticity command (direction=undo|redo).

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `direction` | enum(undo | redo) | 是 | History direction. |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 120000 ms。

## `plasticity_launch`

Start Plasticity with a loopback DevTools port so the bridge can drive it. isolated=true starts a throw-away user-data directory (safe while your own window is open); isolated=false drives your normal session, which requires Plasticity to be closed first. Optionally killExisting=true closes running Plasticity instances first.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `isolated` | boolean |  | Use a throw-away user-data directory instead of your normal session (default false). |
| `killExisting` | boolean |  | Kill every running Plasticity.exe first (default false). |
| `rendererPort` | integer |  | Loopback DevTools port (default 9223). |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 180000 ms。

## `plasticity_measure`

Measure native B-rep bodies: volume (mm³), surface area (mm²), bounding box, size and native validity codes. Omit ids to measure every solid/sheet in the document.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ids` | array<string> |  | Body ids from plasticity_scene; omit for all bodies. |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 120000 ms。

## `plasticity_scene`

Read the current document: bodies with public ids, type, name, bbox (mm), face/edge ids, and per-face/per-edge geometry when includeTopology=true. Body ids returned here are the ids every other tool takes.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `includeTopology` | boolean |  | Include faces/edges detail (default true; set false for a compact listing). |
| `bodyLimit` | integer |  | Max bodies to return topology for (default 40). |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 180000 ms。

## `plasticity_screenshot`

Capture the Plasticity viewport as a PNG. Saves it under .dsh-plasticity/shots/ and returns it as an image block when the host provides attachments. Use it to verify what the model looks like after a change.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `dismissDialogs` | boolean |  | Send Escape before capturing to close a half-open tool dialog (default true). |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 60000 ms。

## `plasticity_script`

Escape hatch: run JavaScript inside the Plasticity renderer with `editor` and the bridge prelude in scope (`editor`, `api`, `geo`, `db`, `find(id)`, `findItem(id)`, `mm/toM`, `Vector`/`Quaternion`/factory bindings are NOT provided automatically). Return a JSON-serializable value. Use it for operations this plugin does not wrap yet.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `code` | string | 是 | Async function body; `return` the value to report. |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 180000 ms。

## `plasticity_shutdown`

Close Plasticity and drop the bridge. Use allInstances=true only when you are sure no window of yours must stay open; the default kills the instance this bridge launched (by its window/pid) via taskkill and leaves the rest alone.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `allInstances` | boolean |  | Kill every Plasticity.exe instead of just the attached instance (default false). |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 60000 ms。

## `plasticity_status`

Report the Plasticity bridge state: whether Plasticity is running, whether the loopback CDP port is reachable, the live tool/command surface, and the current scene summary. Use it first; then plasticity_launch if not connected.

_无参数。_

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 60000 ms。

## `plasticity_transform`

Transform native bodies: translate (translateMm), rotate (rotateAxis + rotateDegrees + optional rotatePivotMm) and/or scale (scaleFactors + optional scalePivotMm). Each provided operation is applied as its own undoable command.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `ids` | array<string> | 是 | Body ids to transform. |
| `translateMm` | array<number> |  | Translation delta (mm) [dx,dy,dz]. |
| `rotateAxis` | array<number> |  | Rotation axis (default [0,0,1]). |
| `rotateDegrees` | number |  | Rotation angle in degrees. |
| `rotatePivotMm` | array<number> |  | Rotation pivot (mm, default origin). |
| `scaleFactors` | array<number> |  | Scale factors [sx,sy,sz]. |
| `scalePivotMm` | array<number> |  | Scale pivot (mm, default origin). |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 240000 ms。

## `plasticity_view`

Aim the Plasticity viewport camera before a screenshot: preset direction (iso/front/back/left/right/top/bottom), explicit fromMm/targetMm, or an automatic distance framed on the current scene bounds. Returns the camera position/target in mm and the scene size.

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `preset` | enum(iso | front | back | left | right | top | bottom) |  | Camera direction preset (default iso). |
| `fromMm` | array<number> |  | Explicit camera position [x,y,z] in mm (overrides preset). |
| `targetMm` | array<number> |  | Explicit look-at point [x,y,z] in mm (default: scene centre). |
| `distanceFactor` | number |  | Distance = scene max dimension × this factor (default 2.6). |

- 返回：自由格式 JSON（宿主以文本 + 可选图片块呈现）；超时 60000 ms。
