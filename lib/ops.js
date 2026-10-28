// CAD operations executed inside Plasticity's own command pipeline.
//
// Page-side snippets are ported from the community plasticity-mcp project (MIT)
// and adapted to this build: flat store (editor.geo.geometryModel), factories
// resolved by name, public body ids = geometryModel versionIds (stable ids).
//
// Units: every public input/output is millimetres / degrees; Plasticity's internal
// unit is metres, so the page-side code converts with toM()/mm().

const COMMAND_BODY = (commandName, assignment) => `
  const commandName = ${JSON.stringify(commandName)};
  if (typeof editor.commands[commandName] !== 'function') {
    throw new Error('Plasticity command is unavailable: ' + commandName);
  }
  if (editor.executor && editor.executor.isBusy) throw new Error('Plasticity is busy; retry shortly');
  let failure = null;
  let created = null;
  const command = new editor.commands[commandName](editor);
  command.remember = false;
  command.execute = async function () {
    try {
      const f = new Factory(editor).resource(this);
      ${assignment}
      created = await f.commit();
      return created;
    } catch (error) { failure = error; throw error; }
  };
  await editor.exec(command);
  if (failure) throw failure;
  return { ok: true, created: describe(created) };
`;

const sceneBody = (includeTopology) => `
  const bodies = [];
  for (const [versionId, item] of geo.geometryModel) {
    const view = item.view;
    const stableId = db.lookupStableId(versionId);
    if (stableId === undefined || stableId === null) continue;
    const type = view && view.constructor ? view.constructor.name : 'Unknown';
    let bounds = null;
    try {
      const box = item.model && item.model.FindBox ? item.model.FindBox() : null;
      if (box && box.min && box.max) bounds = { min: vecMm(box.min), max: vecMm(box.max) };
    } catch {}
    const entry = {
      id: stableId,
      versionId,
      type,
      name: nameOf(view),
      boundsMm: bounds,
      faceIds: Array.from((view && view.high && view.high.faces && view.high.faces.versionIds) || []).map(String),
      edgeIds: Array.from((view && view.high && view.high.edges && view.high.edges.versionIds) || []).map(String),
    };
    if (${includeTopology ? "true" : "false"} && (type === 'Solid' || type === 'Sheet')) {
      const faces = [], edges = [];
      try {
        const faceViews = view.high && view.high.faces;
        const edgeViews = view.high && view.high.edges;
        const faceIdByEntity = new Map();
        const edgeIdByEntity = new Map();
        for (let i = 0; i < (faceViews && faceViews.versionIds ? faceViews.versionIds.length : 0); i += 1) {
          const fv = faceViews.get(i);
          if (fv) faceIdByEntity.set(fv.entityId, String(faceViews.versionIds[i]));
        }
        for (let i = 0; i < (edgeViews && edgeViews.versionIds ? edgeViews.versionIds.length : 0); i += 1) {
          const ev = edgeViews.get(i);
          if (ev) edgeIdByEntity.set(ev.entityId, String(edgeViews.versionIds[i]));
        }
        const modelFaces = item.model && item.model.GetFaces ? item.model.GetFaces() : null;
        for (let i = 0; i < (modelFaces && modelFaces.Size ? modelFaces.Size() : 0); i += 1) {
          const face = modelFaces.Get(i);
          const id = faceIdByEntity.get(face.Id());
          if (!id) continue;
          let center = null, normal = null, radius = null, planar = false;
          try { const mid = face.FindMidpoint(); center = vecMm(mid.position); normal = dir(mid.normal); } catch {}
          try { planar = !!face.IsPlanar(); } catch {}
          try { const r = face.GetRadius(); if (Number.isFinite(r) && r > 0) radius = mm(r); } catch {}
          faces.push({ id, planar, centerMm: center, normal, radiusMm: radius });
        }
        const modelEdges = item.model && item.model.GetEdges ? item.model.GetEdges() : null;
        for (let i = 0; i < (modelEdges && modelEdges.Size ? modelEdges.Size() : 0); i += 1) {
          const edge = modelEdges.Get(i);
          const id = edgeIdByEntity.get(edge.Id());
          if (!id) continue;
          let center = null, tangent = null, lengthMm = null, line = false, circle = false;
          try { const mid = edge.GetPointAndTangent(0.5); center = vecMm(mid.position); tangent = dir(mid.tangent); } catch {}
          try { const len = edge.FindLength(); lengthMm = mm(len.length ?? len); } catch {}
          try { line = !!edge.IsLine(); } catch {}
          try { circle = !!edge.IsCircle(); } catch {}
          edges.push({ id, line, circle, lengthMm, centerMm: center, tangent });
        }
      } catch {}
      entry.faces = faces;
      entry.edges = edges;
    }
    bodies.push(entry);
  }
  return {
    document: String((this.document && (this.document.uuid || this.document.filename)) || 'untitled'),
    undoDepth: (this.history && this.history.undoStack && this.history.undoStack.length) || 0,
    redoDepth: (this.history && this.history.redoStack && this.history.redoStack.length) || 0,
    bodies,
  };
`;

export function createOps(session) {
  const sceneIds = async () => {
    const scene = await session.runRaw(sceneBody(false), {});
    return new Map((scene.bodies ?? []).map((body) => [String(body.id), body]));
  };
  const annotateAdditions = async (before, result) => {
    const after = await sceneIds();
    const added = [];
    for (const [id, body] of after) if (!before.has(id)) added.push(body);
    return { ...(result ?? {}), added };
  };
  return {
    async bootstrap() {
      return await session.ensureBootstrap();
    },

    async scene(options = {}) {
      const includeTopology = options.includeTopology !== false;
      return await session.runRaw(sceneBody(includeTopology), {}, { timeoutMs: 180_000 });
    },

    async measure(ids) {
      return await session.runRaw(`
        return args.ids.map((id) => {
          const found = findItem(id);
          const collection = typeof db.lookupBodyCollection === 'function' ? db.lookupBodyCollection([found.versionId]) : null;
          if (!collection) throw new Error('Body collection lookup is unavailable');
          const props = typeof collection.EvaluateMassProperties === 'function' ? collection.EvaluateMassProperties() : null;
          const amounts = props && props.amounts ? Array.from(props.amounts, Number) : [];
          const peripheries = props && props.peripheries ? Array.from(props.peripheries, Number) : [];
          let box = null;
          try { const b = found.item.model.FindBox(); box = { min: vecMm(b.min), max: vecMm(b.max) }; } catch {}
          let check = [];
          try { check = Array.from(found.item.model.Check(), Number); } catch {}
          return {
            id,
            versionId: found.versionId,
            name: nameOf(found.item.view),
            type: String((found.item.view.constructor && found.item.view.constructor.name) || ''),
            volumeMm3: amounts.length ? amounts[0] * 1e9 : null,
            surfaceAreaMm2: peripheries.length ? peripheries[0] * 1e6 : null,
            boundsMm: box,
            sizeMm: box ? [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]] : null,
            nativeCheckCodes: check,
            massPropertyKeys: props ? Object.keys(props) : null,
          };
        });
      `, { ids }, { timeoutMs: 120_000 });
    },

    async createBox({ originMm, sizeMm }) {
      const before = await sceneIds();
      const [ox, oy, oz] = originMm;
      const [sx, sy, sz] = sizeMm;
      const result = await session.runNative({
        factory: ["ThreePointBoxFactory"],
        needVector: true,
        values: [{ ox, oy, oz, sx, sy, sz }],
        body: COMMAND_BODY(
          "ThreePointBoxCommand",
          `const x = toM(args.ox), y = toM(args.oy), z = toM(args.oz);
           const w = toM(args.sx), d = toM(args.sy), h = toM(args.sz);
           f.p1 = new Vector(x, y, z);
           f.p2 = new Vector(x + w, y, z);
           f.p3 = new Vector(x + w, y + d, z);
           f.p4 = new Vector(x + w, y + d, z + h);`,
        ),
      });
      return await annotateAdditions(before, result);
    },

    async createCylinder({ centerMm, radiusMm, heightMm, axis = [0, 0, 1] }) {
      const before = await sceneIds();
      const result = await session.runNative({
        factory: ["CylinderFactory", "PossiblyBooleanCylinderFactory"],
        needVector: true,
        needQuaternion: true,
        values: [{ center: centerMm, radius: radiusMm, height: heightMm, axis }],
        body: COMMAND_BODY(
          "CylinderCommand",
          `f.center.fromArray(args.center.map(toM));
           f.orientation.copy(new Quaternion().setFromUnitVectors(new Vector(0, 0, 1), new Vector(args.axis[0], args.axis[1], args.axis[2]).normalize()));
           f.radius = toM(args.radius);
           f.height = toM(args.height);`,
        ),
      });
      return await annotateAdditions(before, result);
    },

    async createSphere({ centerMm, radiusMm }) {
      const before = await sceneIds();
      const result = await session.runNative({
        factory: ["SphereFactory", "PossiblyBooleanSphereFactory"],
        values: [{ center: centerMm, radius: radiusMm }],
        body: COMMAND_BODY(
          "SphereCommand",
          `f.center.fromArray(args.center.map(toM));
           f.radius = toM(args.radius);`,
        ),
      });
      return await annotateAdditions(before, result);
    },

    /** Extrude existing faces of a body. */
    async extrudeFaces({ bodyId, faceIds, distanceMm }) {
      return await session.runNative({
        factory: ["ExtrudeFactory"],
        values: [{ bodyId, faceIds, distance: distanceMm / 1000 }],
        body: COMMAND_BODY(
          "ExtrudeCommand",
          `const view = find(args.bodyId);
           const faces = (view.high && view.high.faces) || null;
           if (!faces) throw new Error('Body has no face topology: ' + args.bodyId);
           f.faces = args.faceIds.map((faceId) => {
             const index = faces.versionIds.indexOf(faceId);
             if (index < 0) throw new Error('Stale or unknown face: ' + faceId);
             return faces.get(index);
           });
           f.distance1 = args.distance;`,
        ),
      });
    },

    /** Extrude a planar polygon (mm, XY plane at planeZMm) into a solid. */
    async extrudeProfile({ pointsMm, planeZMm = 0, distanceMm }) {
      // Plasticity only creates a native region for a closed, counter-clockwise loop.
      const points = pointsMm.map((point) => [Number(point[0]), Number(point[1])]);
      let area = 0;
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        area += a[0] * b[1] - b[0] * a[1];
      }
      if (area < 0) points.reverse();
      const flat = [];
      for (const point of points) flat.push(point[0], point[1]);
      return await session.runNative({
        factories: [
          { param: "Extrude", names: ["ExtrudeFactory"] },
          { param: "Curve", names: ["CurveFactory"] },
        ],
        needVector: true,
        values: [{ flat, planeZ: planeZMm / 1000, distance: distanceMm / 1000 }],
        body: `
          if (typeof editor.commands.CurveCommand !== 'function') throw new Error('CurveCommand unavailable');
          if (editor.executor && editor.executor.isBusy) throw new Error('Plasticity is busy; retry shortly');
          const before = new Set();
          for (const [versionId, item] of geo.geometryModel) {
            const kind = item.view && item.view.constructor ? item.view.constructor.name : '';
            if (kind !== 'SketchIsland') continue;
            for (let i = 0; i < (item.view.regions ? item.view.regions.length : 0); i += 1) {
              const region = item.view.regions.get(i);
              if (region) before.add(String(region.versionId));
            }
          }
          let curveFailure = null;
          const curveCommand = new editor.commands.CurveCommand(editor);
          curveCommand.remember = false;
          curveCommand.execute = async function () {
            try {
              const f = new Curve(editor).resource(this);
              const points = [];
              for (let i = 0; i + 1 < args.flat.length; i += 2) points.push(new Vector(args.flat[i] / 1000, args.flat[i + 1] / 1000, args.planeZ));
              f.points = points;
              f.type = 0;
              f.closed = true;
              return await f.commit();
            } catch (error) { curveFailure = error; throw error; }
          };
          await editor.exec(curveCommand);
          if (curveFailure) throw curveFailure;
          const regions = [];
          for (const [versionId, item] of geo.geometryModel) {
            const kind = item.view && item.view.constructor ? item.view.constructor.name : '';
            if (kind !== 'SketchIsland') continue;
            for (let i = 0; i < (item.view.regions ? item.view.regions.length : 0); i += 1) {
              const region = item.view.regions.get(i);
              if (region && !before.has(String(region.versionId))) regions.push(region);
            }
          }
          if (regions.length === 0) throw new Error('Profile produced no closed region; check point order');
          if (regions.length > 1) throw new Error('Profile produced ' + regions.length + ' regions; split the polygon');
          let extrudeFailure = null;
          const extrudeCommand = new editor.commands.ExtrudeCommand(editor);
          extrudeCommand.remember = false;
          extrudeCommand.execute = async function () {
            try {
              const f = new Extrude(editor).resource(this);
              f.regions = regions;
              f.distance1 = args.distance;
              return await f.commit();
            } catch (error) { extrudeFailure = error; throw error; }
          };
          await editor.exec(extrudeCommand);
          if (extrudeFailure) throw extrudeFailure;
          return { ok: true, regions: regions.length };
        `,
      });
    },

    async boolean({ operation, targetIds, toolIds, keepTools = false }) {
      const operationType = { union: 15903, difference: 15902, intersection: 15901 }[operation];
      if (!operationType) throw new Error(`unsupported boolean operation: ${operation} (union|difference|intersection)`);
      return await session.runNative({
        factory: ["BooleanFactory"],
        values: [{ targetIds, toolIds, operationType, keepTools }],
        body: COMMAND_BODY(
          "BooleanCommand",
          `f.targets = args.targetIds.map(find);
           f.tools = args.toolIds.map(find);
           f.operationType = args.operationType;
           f.keepTools = !!args.keepTools;`,
        ),
      });
    },

    async fillet({ bodyId, edgeIds, distanceMm, chamfer = false }) {
      return await session.runNative({
        factory: ["FilletShellFactory"],
        values: [{ bodyId, edgeIds, distance: distanceMm / 1000, chamfer }],
        body: COMMAND_BODY(
          "FilletShellCommand",
          `const view = find(args.bodyId);
           const edges = (view.high && view.high.edges) || null;
           if (!edges) throw new Error('Body has no edge topology: ' + args.bodyId);
           f.shell = view;
           f.edges = args.edgeIds.map((edgeId) => {
             const index = edges.versionIds.indexOf(edgeId);
             if (index < 0) throw new Error('Stale or unknown edge: ' + edgeId);
             return edges.get(index);
           });
           f.distance = args.chamfer ? -Math.abs(args.distance) : Math.abs(args.distance);`,
        ),
      });
    },

    async move({ ids, deltaMm }) {
      return await session.runNative({
        factory: ["MoveItemAndEmptyFactory", "MoveItemFactory"],
        values: [{ ids, delta: deltaMm.map((v) => v / 1000) }],
        body: COMMAND_BODY(
          "MoveItemCommand",
          `f.items = args.ids.map(find);
           f.move.fromArray(args.delta);`,
        ),
      });
    },

    async rotate({ ids, pivotMm = [0, 0, 0], axis = [0, 0, 1], degrees }) {
      return await session.runNative({
        factory: ["RotateItemAndEmptyFactory"],
        needVector: true,
        needQuaternion: true,
        values: [{ ids, pivot: pivotMm.map((v) => v / 1000), axis, radians: (degrees * Math.PI) / 180 }],
        body: COMMAND_BODY(
          "RotateItemCommand",
          `f.items = args.ids.map(find);
           f.pivot.fromArray(args.pivot);
           f.rotation.copy(new Quaternion().setFromAxisAngle(new Vector(args.axis[0], args.axis[1], args.axis[2]).normalize(), args.radians));`,
        ),
      });
    },

    async scale({ ids, pivotMm = [0, 0, 0], factors }) {
      return await session.runNative({
        factory: ["ProjectingScaleItemAndEmptyFactory", "ScaleItemAndEmptyFactory"],
        values: [{ ids, pivot: pivotMm.map((v) => v / 1000), factors }],
        body: COMMAND_BODY(
          "ScaleItemCommand",
          `f.items = args.ids.map(find);
           f.pivot.fromArray(args.pivot);
           f.scale.fromArray(args.factors);`,
        ),
      });
    },

    async remove(ids) {
      return await session.runRaw(`
        const ids = args.ids || [];
        if (ids.length === 0) throw new Error('At least one body id is required');
        if (editor.executor && editor.executor.isBusy) throw new Error('Plasticity is busy; retry shortly');
        const views = ids.map(find);
        if (!editor.selection || !editor.selection.selected) throw new Error('Plasticity selection is unavailable');
        editor.selection.selected.removeAll();
        for (const view of views) editor.selection.selected.add(view);
        if (typeof editor.commands.DeleteCommand !== 'function') throw new Error('DeleteCommand unavailable');
        const command = new editor.commands.DeleteCommand(editor);
        command.remember = false;
        let failure = null;
        const execute = command.execute.bind(command);
        command.execute = async function () {
          try { return await execute(); } catch (error) { failure = error; throw error; }
        };
        await editor.exec(command);
        if (failure) throw failure;
        return { ok: true, removed: ids.length };
      `, { ids });
    },

    async undo() {
      return await session.runRaw(`
        if (editor.executor && editor.executor.isBusy) throw new Error('Plasticity is busy; retry shortly');
        if (typeof editor.undo !== 'function') throw new Error('editor.undo is unavailable');
        await editor.undo();
        return { ok: true, undoDepth: (editor.history && editor.history.undoStack && editor.history.undoStack.length) || 0 };
      `, {});
    },

    async redo() {
      return await session.runRaw(`
        if (editor.executor && editor.executor.isBusy) throw new Error('Plasticity is busy; retry shortly');
        if (typeof editor.redo !== 'function') throw new Error('editor.redo is unavailable');
        await editor.redo();
        return { ok: true, redoDepth: (editor.history && editor.history.redoStack && editor.history.redoStack.length) || 0 };
      `, {});
    },

    async exportCad({ format, ids, path, chordToleranceMm, angleToleranceDegrees }) {
      const normalized = String(format).toLowerCase();
      const spec = {
        step: { factory: ["ExportCadFactory"], kind: "cad" },
        stl: { factory: ["STLExportFactory"], kind: "mesh" },
        "3mf": { factory: ["ThreeMfExportFactory"], kind: "mesh" },
        obj: { factory: ["OBJExportFactory"], kind: "mesh" },
      }[normalized];
      if (!spec) throw new Error(`unsupported export format: ${format} (use step|stl|3mf|obj)`);
      const tolerance = chordToleranceMm ?? 0.05;
      const angle = angleToleranceDegrees ?? 5;
      const body = spec.kind === "cad"
        ? `
        if (editor.executor && editor.executor.isBusy) throw new Error('Plasticity is busy; retry shortly');
        const f = new Factory(editor);
        f.items = args.ids.map(find);
        f.filePath = args.path;
        await f.commit();
        return { ok: true, items: args.ids.length };`
        : `
        if (editor.executor && editor.executor.isBusy) throw new Error('Plasticity is busy; retry shortly');
        const f = new Factory(editor);
        f.shells = args.ids.map(find);
        f.filePath = args.path;
        f.unit = 'millimeter';
        ${normalized === "3mf" ? "f.scale = 0.001;" : ""}
        ${normalized === "obj" ? "f.scale = 1; f.upAxis = 'z'; f.showWireframe = false; f.simplify = false;" : ""}
        f.curveChordTolerance = args.chordTolerance;
        f.surfacePlaneTolerance = args.chordTolerance;
        f.curveChordAngleDegrees = args.angleToleranceDegrees;
        f.surfacePlaneAngleDegrees = args.angleToleranceDegrees;
        await f.commit();
        return { ok: true, items: args.ids.length };`;
      return await session.runNative({
        factory: spec.factory,
        values: [{ ids, path, chordTolerance: tolerance / 1000, angleToleranceDegrees: angle }],
        body,
        timeoutMs: 300_000,
      });
    },

    /**
     * Camera control: preset direction (iso/front/back/left/right/top/bottom),
     * explicit from/target in mm, and an automatic distance from the scene bounds.
     */
    async view({ preset = "iso", fromMm, targetMm, distanceFactor = 3.4 } = {}) {
      return await session.runRaw(`
        const vp = Array.from(this.viewports || [])[0];
        if (!vp || !vp.camera) throw new Error('Plasticity viewport camera is unavailable');
        const cam = vp.camera;
        let min = [Infinity, Infinity, Infinity];
        let max = [-Infinity, -Infinity, -Infinity];
        for (const [versionId, item] of geo.geometryModel) {
          const stableId = db.lookupStableId(versionId);
          if (stableId === undefined || stableId === null) continue;
          try {
            const box = item.model.FindBox();
            if (!box || !box.min || !box.max) continue;
            const lo = [box.min.x, box.min.y, box.min.z];
            const hi = [box.max.x, box.max.y, box.max.z];
            for (let i = 0; i < 3; i += 1) { min[i] = Math.min(min[i], lo[i]); max[i] = Math.max(max[i], hi[i]); }
          } catch {}
        }
        if (!Number.isFinite(min[0])) { min = [-0.5, -0.5, 0]; max = [0.5, 0.5, 1]; }
        const center = [0, 1, 2].map((i) => (min[i] + max[i]) / 2);
        const size = [0, 1, 2].map((i) => Math.max(max[i] - min[i], 0.001));
        const radius = Math.max(size[0], size[1], size[2]);
        const presets = {
          iso: [0.9, -1.15, 0.85], front: [0, -1, 0], back: [0, 1, 0],
          left: [-1, 0, 0], right: [1, 0, 0], top: [0, 0, 1], bottom: [0, 0, -1],
        };
        let target;
        let position;
        if (Array.isArray(args.fromMm)) {
          position = args.fromMm.map((v) => v / 1000);
          target = Array.isArray(args.targetMm) ? args.targetMm.map((v) => v / 1000) : center.slice();
        } else {
          const dir = presets[args.preset] || presets.iso;
          const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
          const distance = radius * (args.distanceFactor || 3.4);
          target = center.slice();
          position = [0, 1, 2].map((i) => center[i] + (dir[i] / len) * distance);
        }
        if (cam.target && typeof cam.target.set === 'function') cam.target.set(target[0], target[1], target[2]);
        cam.position.set(position[0], position[1], position[2]);
        if (typeof cam.lookAt === 'function') cam.lookAt(target[0], target[1], target[2]);
        cam.updateMatrixWorld(true);
        if (typeof vp.validate === 'function') vp.validate();
        if (typeof vp.setNeedsRender === 'function') vp.setNeedsRender();
        return {
          preset: args.fromMm ? 'custom' : args.preset,
          positionMm: position.map((v) => v * 1000),
          targetMm: target.map((v) => v * 1000),
          sceneSizeMm: size.map((v) => v * 1000),
        };
      `, { preset, fromMm: fromMm ?? null, targetMm: targetMm ?? null, distanceFactor }, { timeoutMs: 30_000 });
    },

    /** Escape hatch: run arbitrary JS with the bridge prelude in scope. */
    async script(code) {
      return await session.runRaw(String(code), {}, { timeoutMs: 120_000 });
    },
  };
}




