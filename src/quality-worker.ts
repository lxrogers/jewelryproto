import { setWasmUrl, getManifoldModule } from 'manifold-3d/lib/wasm';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

// Minimal SDF pieces copied for worker
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function sdfRing(
  x: number, y: number, z: number,
  innerDiameter: number, thickness: number, width: number, edgeFillet: number
): number {
  const innerR = innerDiameter / 2;
  const outerR = innerR + thickness;
  const midR = (innerR + outerR) / 2;
  const halfThickness = thickness / 2;
  const halfW = width / 2;
  const distToAxis = Math.sqrt(x * x + z * z);
  const px = distToAxis - midR;
  const py = y;
  const bx = halfThickness - edgeFillet;
  const by = halfW - edgeFillet;
  const dx = Math.abs(px) - bx;
  const dy = Math.abs(py) - by;
  const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2);
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - edgeFillet;
}

function sdfBox(
  px: number, py: number, pz: number,
  cx: number, cy: number, cz: number,
  sx: number, sy: number, sz: number,
  rounding = 0
): number {
  const dx = Math.abs(px - cx) - sx + rounding;
  const dy = Math.abs(py - cy) - sy + rounding;
  const dz = Math.abs(pz - cz) - sz + rounding;
  const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
  const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
  return outside + inside - rounding;
}

function ringWithFeatures(
  point: number[],
  innerDiameter: number,
  thickness: number,
  width: number,
  edgeFillet: number,
  blendK: number,
  showBar: boolean,
  barDepth: number
): number {
  const [x, y, z] = point;
  let d = sdfRing(x, y, z, innerDiameter, thickness, width, edgeFillet);

  if (showBar) {
    const outerR = innerDiameter / 2 + thickness;
    const barLength = (outerR - barDepth / 2) * 2;
    const barD = sdfBox(
      x, y, z,
      0, 0, 0,
      barLength / 2, width / 2 - edgeFillet, barDepth / 2 - edgeFillet,
      edgeFillet
    );
    d = smin(d, barD, blendK);
  }

  return -d;
}

let Manifold: any;
let wasmReady: Promise<void> | null = null;

async function ensureWasm() {
  if (!wasmReady) {
    wasmReady = (async () => {
      setWasmUrl(wasmUrl);
      const wasm = await getManifoldModule();
      Manifold = wasm.Manifold;
      console.log('[worker] Manifold WASM ready');
    })();
  }
  return wasmReady;
}

type JobPayload = {
  jobId: number;
  params: {
    innerDiameter: number;
    thickness: number;
    width: number;
    edgeFillet: number;
    blendK: number;
    showBar: boolean;
    barDepth: number;
    resolution: number;
  };
};

self.onmessage = async (event: MessageEvent<JobPayload>) => {
  const { jobId, params } = event.data;
  try {
    await ensureWasm();
    const { innerDiameter, thickness, width, edgeFillet, blendK, showBar, barDepth, resolution } = params;

    const t0 = performance.now();
    const basePad = 0.2;
    const padding = Math.max(basePad, resolution * 2);
    const outerR = innerDiameter / 2 + thickness + padding;
    const halfH = width / 2 + padding;
    const bounds = {
      min: [-outerR, -halfH, -outerR],
      max: [outerR, halfH, outerR],
    };

    const ring = Manifold.levelSet(
      (p: number[]) => ringWithFeatures(p, innerDiameter, thickness, width, edgeFillet, blendK, showBar, barDepth),
      bounds,
      resolution,
      0
    );
    const meshTime = performance.now();

    const mesh = ring.getMesh();
    const extractTime = performance.now();

    const vertices = mesh.vertProperties.slice(); // Float32Array-like
    const indices = mesh.triVerts.slice();

    ring.delete();

    const total = performance.now() - t0;
    (self as any).postMessage(
      {
        jobId,
        jobParams: params,
        vertices,
        indices,
        timings: {
          total: total.toFixed(0),
          levelSet: (meshTime - t0).toFixed(0),
          extract: (extractTime - meshTime).toFixed(0),
        },
      },
      [vertices.buffer, indices.buffer]
    );
  } catch (error: any) {
    (self as any).postMessage({ jobId, error: error?.message || String(error) });
  }
};
