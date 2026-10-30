/**
 * Plus sign made of two blended cylinders (SDF + manifold-3d levelSet)
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import GUI from 'lil-gui';
import { setWasmUrl, getManifoldModule } from 'manifold-3d/lib/wasm';
import wasmUrl from 'manifold-3d/manifold.wasm?url';

let wasm: any;
let Manifold: any;

let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let mesh: THREE.Mesh | null = null;
let statsElement: HTMLElement;
let updateTimeout: number | null = null;

const params = {
  radiusX: 3.0,         // cylinder radius along X (mm)
  radiusZ: 3.0,         // cylinder radius along Z (mm)
  halfLength: 12.0,     // half-length of each arm (mm)
  blendK: 1.0,          // smooth union radius
  twistDeg: 0,          // rotate the Z arm around Y
  resolution: 0.25,     // voxel size for levelSet
  blendMode: 'default' as 'default' | 'preserve' | 'shrink-offset' | 'hard' | 'chamfer' | 'z-guard' | 'xz-only' | 'boolean-dilate',
  planeStrictness: 0.1, // for xz-only: how quickly smoothing fades with |y|
  color: '#777777',
  metalness: 0.7,
  roughness: 0.25,
};

// --- SDF helpers ---
function smin(a: number, b: number, k: number): number {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

function sminPreserve(a: number, b: number, k: number): number {
  // Smooth union that compensates for bulging by offsetting before/after blend
  const ao = a - k;
  const bo = b - k;
  const h = Math.max(k - Math.abs(ao - bo), 0) / k;
  const s = Math.min(ao, bo) - h * h * k * 0.25;
  return s + k;
}

function chamferUnion(a: number, b: number, k: number): number {
  // Simple chamfered union (linear blend) that does not inflate radius
  const c = Math.min(Math.min(a, b), (a + b + k) / Math.SQRT2);
  return c;
}

// Capped cylinder aligned to X axis
function sdfCylinderX(x: number, y: number, z: number, halfLength: number, radius: number): number {
  const dx = Math.abs(x) - halfLength;
  const radial = Math.sqrt(y * y + z * z) - radius;
  const ax = Math.max(dx, 0);
  const ay = Math.max(radial, 0);
  const outside = Math.sqrt(ax * ax + ay * ay);
  const inside = Math.min(Math.max(dx, radial), 0);
  return outside + inside;
}

// Capped cylinder aligned to Z axis
function sdfCylinderZ(x: number, y: number, z: number, halfLength: number, radius: number): number {
  const dz = Math.abs(z) - halfLength;
  const radial = Math.sqrt(x * x + y * y) - radius;
  const ax = Math.max(dz, 0);
  const ay = Math.max(radial, 0);
  const outside = Math.sqrt(ax * ax + ay * ay);
  const inside = Math.min(Math.max(dz, radial), 0);
  return outside + inside;
}

function sdfPlusCyl(p: number[]): number {
  const [x, y, z] = p;
  const radX = params.radiusX;
  const radZ = params.radiusZ;
  const minRad = Math.min(radX, radZ);

  let c1 = sdfCylinderX(x, y, z, params.halfLength, radX);
  // rotate Z arm around Y by twistDeg
  const ang = THREE.MathUtils.degToRad(params.twistDeg);
  const cz = Math.cos(ang) * z - Math.sin(ang) * x;
  const cx = Math.sin(ang) * z + Math.cos(ang) * x;
  let c2 = sdfCylinderZ(cx, y, cz, params.halfLength, radZ);

  if (params.blendMode === 'preserve') {
    const k = params.blendK * 0.6; // softer blend to reduce bulge
    return -sminPreserve(c1, c2, k);
  } else if (params.blendMode === 'shrink-offset') {
    const k = params.blendK * 1.2; // shrink more aggressively
    c1 -= k;
    c2 -= k;
    return -(smin(c1, c2, k) + k);
  } else if (params.blendMode === 'chamfer') {
    return -chamferUnion(c1, c2, params.blendK);
  } else if (params.blendMode === 'z-guard') {
    // Guard against swelling in Y by clamping smoothing where |y| is large
    const k = params.blendK;
    const guard = Math.max(0, Math.abs(y) - (minRad + k * 0.5));
    const smooth = smin(c1, c2, k);
    const hard = Math.min(c1, c2);
    const t = guard > 0 ? 0 : 1; // if beyond guard, use hard
    return -THREE.MathUtils.lerp(hard, smooth, t);
  } else if (params.blendMode === 'xz-only') {
    // Blend only near the ground plane (small |y|); fade smoothing and shrink k away from it
    const k = params.blendK;
    const yAbs = Math.abs(y);
    const blendStart = minRad + k * params.planeStrictness;
    const blendEnd = minRad;
    const t = THREE.MathUtils.clamp((blendStart - yAbs) / Math.max(1e-6, blendStart - blendEnd), 0, 1);
    const kScaled = k * t;
    const union = t > 0 ? smin(c1, c2, kScaled) : Math.min(c1, c2);
    return -union;
  } else if (params.blendMode === 'boolean-dilate') {
    // Hard union first, then a simple offset/dilate by blendK (no double bulge from per-shape smoothing)
    const h = Math.min(c1, c2);
    return -(h - params.blendK);
  } else if (params.blendMode === 'hard') {
    return -Math.min(c1, c2);
  }

  // Default smooth union
  return -smin(c1, c2, params.blendK);
}

// --- Meshing ---
function generateMesh(): THREE.BufferGeometry {
  const maxRad = Math.max(params.radiusX, params.radiusZ);
  const padding = Math.max(0.3, params.resolution * 2 + params.blendK * 0.5);
  const extent = params.halfLength + maxRad + padding;
  const bounds = {
    min: [-extent, -extent, -extent],
    max: [extent, extent, extent],
  };

  const t0 = performance.now();
  const manifold = Manifold.levelSet(sdfPlusCyl, bounds, params.resolution, 0);
  const meshData = manifold.getMesh();
  const t1 = performance.now();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(meshData.vertProperties, 3));
  geometry.setIndex(new THREE.BufferAttribute(meshData.triVerts, 1));
  geometry.computeVertexNormals();

  manifold.delete();

  console.log(
    `levelSet ${(t1 - t0).toFixed(0)}ms | verts ${meshData.numVert.toLocaleString()} tris ${meshData.numTri.toLocaleString()}`
  );

  return geometry;
}

function updateMesh(): void {
  if (!wasm) return;
  if (updateTimeout) clearTimeout(updateTimeout);
  updateTimeout = window.setTimeout(() => {
    try {
      const geometry = generateMesh();
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geometry;
        mesh.position.y = Math.max(params.radiusX, params.radiusZ);
      } else {
        const material = new THREE.MeshStandardMaterial({
          color: params.color,
          metalness: params.metalness,
          roughness: params.roughness,
          envMapIntensity: 1.0,
        });
        mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.y = Math.max(params.radiusX, params.radiusZ);
        scene.add(mesh);
      }
      updateStats();
    } catch (err) {
      console.error('Failed to update mesh:', err);
    }
  }, 50);
}

function updateStats(): void {
  if (!statsElement || !mesh) return;
  const geom = mesh.geometry;
  const verts = geom.getAttribute('position').count;
  const tris = geom.getIndex() ? geom.getIndex()!.count / 3 : verts / 3;
  statsElement.textContent = `Vertices: ${verts.toLocaleString()} | Triangles: ${tris.toLocaleString()}`;
}

// --- Three.js setup ---
function initThree(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const container = canvas.parentElement!;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(45, container.clientWidth / container.clientHeight, 0.1, 200);
  camera.position.set(40, 40, 40);

  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.target.set(0, 0, 0);

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 400),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 1 })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.receiveShadow = true;
  scene.add(plane);

  new RGBELoader().load('./softbox.hdr', (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdr;
  });

  const ambient = new THREE.AmbientLight(0xffffff, 0.2);
  scene.add(ambient);

  const key = new THREE.DirectionalLight(0xffffff, 3.0);
  key.position.set(-20, 30, -20);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 1.0);
  fill.position.set(25, 15, 20);
  scene.add(fill);

  window.addEventListener('resize', () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  });
}

// --- UI ---
function initGUI(): void {
  const gui = new GUI({ title: 'Plus Cylinders' });

  const shape = gui.addFolder('Shape');
  shape.add(params, 'radiusX', 0.5, 8, 0.1).name('Radius X').onChange(updateMesh);
  shape.add(params, 'radiusZ', 0.5, 8, 0.1).name('Radius Z').onChange(updateMesh);
  shape.add(params, 'halfLength', 2, 15, 0.5).name('Half Length').onChange(updateMesh);
  shape.add(params, 'blendK', 0, 4, 0.05).name('Blend Radius').onChange(updateMesh);
  shape.add(params, 'twistDeg', -90, 90, 1).name('Twist Angle').onChange(updateMesh);
  shape.add(params, 'blendMode', ['default', 'preserve', 'shrink-offset', 'hard', 'chamfer', 'z-guard', 'xz-only', 'boolean-dilate']).name('Blend Mode').onChange(updateMesh);
  shape.add(params, 'planeStrictness', 0.01, 2.5, 0.01).name('XZ Strictness').onChange(updateMesh);

  const quality = gui.addFolder('Quality');
  quality.add(params, 'resolution', 0.05, 0.8, 0.01).name('Resolution').onChange(updateMesh);

  const material = gui.addFolder('Material');
  material.addColor(params, 'color').name('Color').onChange(updateMesh);
  material.add(params, 'metalness', 0, 1, 0.01).name('Metalness').onChange(updateMesh);
  material.add(params, 'roughness', 0, 1, 0.01).name('Roughness').onChange(updateMesh);
}

// --- Main ---
async function init(): Promise<void> {
  const loading = document.getElementById('loading');
  const loadingText = document.querySelector('.loading-text') as HTMLElement | null;

  try {
    statsElement = document.getElementById('stats')!;
    setWasmUrl(wasmUrl);
    wasm = await getManifoldModule();
    Manifold = wasm.Manifold;
    console.log('Manifold WASM ready');

    initThree();
    initGUI();
    updateMesh();
    animate();

    if (loading) loading.classList.add('hidden');
  } catch (err: any) {
    console.error('Failed to initialize plus-cyl demo:', err);
    if (loadingText) loadingText.textContent = `Error: ${err?.message || err}`;
  }
}

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
