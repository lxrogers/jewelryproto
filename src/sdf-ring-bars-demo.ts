/**
 * Ring with multiple smooth bars using SDF + manifold-3d levelSet
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
  innerDiameter: 19.5,
  thickness: 2.2,
  width: 3.3,
  edgeFillet: 0.5,
  blendK: 0.85,
  barCount: 4,
  barDepth: 2.4,
  barSpacing: 3.0,   // offset between bars along Z to avoid stacking
  resolution: 0.2,
  color: '#555555',
  metalness: 0.8,
  roughness: 0.2,
};

// --- SDF helpers ---
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
  sx: number, sy: number, sz: number,
  rounding = 0
): number {
  const dx = Math.abs(px) - sx + rounding;
  const dy = Math.abs(py) - sy + rounding;
  const dz = Math.abs(pz) - sz + rounding;
  const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
  const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
  return outside + inside - rounding;
}

function rotateY(x: number, z: number, angle: number): { x: number; z: number } {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return {
    x: c * x + s * z,
    z: -s * x + c * z,
  };
}

function sdfRingWithBars(p: number[]): number {
  const [x, y, z] = p;
  let d = sdfRing(x, y, z, params.innerDiameter, params.thickness, params.width, params.edgeFillet);

  if (params.barCount > 0 && params.barDepth > 0) {
    const innerR = params.innerDiameter / 2;
    const outerR = innerR + params.thickness;
    const barLen = (outerR - params.barDepth / 2) * 2;
    const halfX = barLen / 2;
    // Match bar height to ring width so bars span the band
    const halfY = Math.max(0.1, params.width / 2 - params.edgeFillet * 0.5);
    const halfZ = params.barDepth / 2 - params.edgeFillet;

    const count = Math.max(1, Math.floor(params.barCount));
    const yCenter = 0; // keep bars at same vertical position

    // Place bars along Z with spacing
    for (let i = 0; i < count; i++) {
      const zOffset = (i - (count - 1) / 2) * params.barSpacing;
      const barD = sdfBox(x, y - yCenter, z - zOffset, halfX, halfY, halfZ, params.edgeFillet);
      d = smin(d, barD, params.blendK);
    }
  }

  // levelSet expects negative inside the solid; invert the sign
  return -d;
}

// --- Meshing ---
function generateMesh(): THREE.BufferGeometry {
  const padding = Math.max(0.2, params.resolution * 2);
  const outerR = params.innerDiameter / 2 + params.thickness + padding;
  const halfH = params.width / 2 + padding;
  const bounds = { min: [-outerR, -halfH, -outerR], max: [outerR, halfH, outerR] };

  const t0 = performance.now();
  const manifold = Manifold.levelSet(sdfRingWithBars, bounds, params.resolution, 0);
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
        mesh.position.y = params.width / 2;
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
        mesh.position.y = params.width / 2;
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
  camera.position.set(50, 50, 50);

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

  new RGBELoader().load('/softbox.hdr', (hdr) => {
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
  const gui = new GUI({ title: 'Ring with Bars' });

  const ring = gui.addFolder('Ring');
  ring.add(params, 'innerDiameter', 14, 22, 0.5).name('Inner Diameter').onChange(updateMesh);
  ring.add(params, 'thickness', 1.5, 5, 0.1).name('Thickness').onChange(updateMesh);
  ring.add(params, 'width', 3, 12, 0.1).name('Width').onChange(updateMesh);
  ring.add(params, 'edgeFillet', 0, 1.5, 0.05).name('Edge Fillet').onChange(updateMesh);

  const bars = gui.addFolder('Bars');
  bars.add(params, 'barCount', 1, 8, 1).name('Count').onChange(updateMesh);
  bars.add(params, 'barDepth', 0.5, 5, 0.1).name('Depth').onChange(updateMesh);
  bars.add(params, 'barSpacing', 0, 3, 0.05).name('Z Spacing').onChange(updateMesh);
  bars.add(params, 'blendK', 0, 1.5, 0.05).name('Blend Radius').onChange(updateMesh);

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
    console.error('Failed to initialize ring-bars demo:', err);
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
