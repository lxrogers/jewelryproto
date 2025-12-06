/**
 * Coin Mesh Demo
 * Interactive demo for the parametric coin mesh generator
 * Uses the rendering pipeline from sun-ring2
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass';
import { TAARenderPass } from 'three/examples/jsm/postprocessing/TAARenderPass';
import GUI from 'lil-gui';

import {
  CoinMeshGenerator,
  createCircleOutline,
  createSuperellipseOutline,
  createBlobOutline,
  createRoundedRectOutline,
  QUALITY_PRESETS,
  DeformationParams,
} from './coin-mesh';

// Global state
let scene: THREE.Scene;
let camera: THREE.PerspectiveCamera;
let renderer: THREE.WebGLRenderer;
let controls: OrbitControls;
let composer: EffectComposer;
let coinMesh: THREE.Mesh | null = null;
let coinGenerator: CoinMeshGenerator | null = null;
let groundPlane: THREE.Mesh;

// Light references
let ambientLight: THREE.AmbientLight;
let sideLight: THREE.DirectionalLight;
let sideLight2: THREE.DirectionalLight;
let fillLight: THREE.DirectionalLight;
let pointLights: THREE.PointLight[] = [];

// Animation settings
let animateLights = true;
let animationSpeed = 0.1;
let animationTime = 0;
const initialLightPositions = {
  light1: { x: -20, y: 35, z: -20 },
  light2: { x: 20, y: 35, z: -20 },
};

// Stats display
let statsElement: HTMLElement;
let lastUpdateTime = 0;

// Parameters with defaults
const params = {
  // Outline type
  outlineType: 'blob' as 'circle' | 'superellipse' | 'blob' | 'roundedRect',

  // Circle params
  circleRadius: 10,

  // Superellipse params
  superellipseA: 10,
  superellipseB: 10,
  superellipseN: 4,

  // Blob params
  blobRadius: 10,
  blobNoiseFreq: 1,
  blobNoiseAmp: 0.13,
  blobSeed: 42,

  // Rounded rect params
  rectWidth: 20,
  rectHeight: 16,
  rectCornerRadius: 4,

  // Coin params
  thickness: 0.5,
  edgeRadius: 0.25,

  // Quality
  quality: 'medium' as 'low' | 'medium' | 'high',
  outlineSamples: 64,
  profileSegments: 12,
  faceRadialSegments: 12, // Number of concentric rings on faces

  // Material
  metalness: 1.0,
  roughness: 0.15,
  color: '#FFD700',

  // Deformation
  deformEnabled: true,
  deformAmplitude: 0.5,
  deformFreqX: 0.1,
  deformFreqZ: 0.1,
  deformPhaseX: 0,
  deformPhaseZ: 0,
  deformOctaves: 2,
  deformPersistence: 0.5,

  // Rendering
  animateLights: true,
};

/**
 * Create ground gradient texture
 */
function createGroundGradientTexture(
  size = 1024,
  middleStop = 0.5,
  endStop = 0.8,
  intensity = 0.8
): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d')!;

  const centerX = size / 2;
  const centerY = size / 2;
  const maxRadius = size / 2;

  const gradient = context.createRadialGradient(
    centerX,
    centerY,
    0,
    centerX,
    centerY,
    maxRadius * endStop
  );

  const white = Math.min(255, 255 * intensity);
  const mediumGray = Math.min(255, 153 * intensity);
  const darkGray = Math.min(255, 102 * intensity);

  gradient.addColorStop(0, `rgb(${white}, ${white}, ${white})`);
  gradient.addColorStop(middleStop, `rgb(${mediumGray}, ${mediumGray}, ${mediumGray})`);
  gradient.addColorStop(1, `rgb(${darkGray}, ${darkGray}, ${darkGray})`);

  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  return canvas;
}

/**
 * Get outline function based on current params
 */
function getOutlineFunction() {
  switch (params.outlineType) {
    case 'circle':
      return createCircleOutline(params.circleRadius);
    case 'superellipse':
      return createSuperellipseOutline(
        params.superellipseA,
        params.superellipseB,
        params.superellipseN
      );
    case 'blob':
      return createBlobOutline(
        params.blobRadius,
        params.blobNoiseFreq,
        params.blobNoiseAmp,
        params.blobSeed
      );
    case 'roundedRect':
      return createRoundedRectOutline(
        params.rectWidth,
        params.rectHeight,
        params.rectCornerRadius
      );
    default:
      return createCircleOutline(10);
  }
}

/**
 * Create or update the coin mesh
 */
function updateCoinMesh(fullRebuild = false): void {
  const startTime = performance.now();

  if (fullRebuild || !coinGenerator) {
    // Build deformation params
    const deformation: DeformationParams = {
      enabled: params.deformEnabled,
      amplitude: params.deformAmplitude,
      frequencyX: params.deformFreqX,
      frequencyZ: params.deformFreqZ,
      phaseX: params.deformPhaseX,
      phaseZ: params.deformPhaseZ,
      octaves: params.deformOctaves,
      persistence: params.deformPersistence,
    };

    // Create new generator
    coinGenerator = new CoinMeshGenerator({
      outline: getOutlineFunction(),
      outlineSamples: params.outlineSamples,
      profileSegments: params.profileSegments,
      thickness: params.thickness,
      edgeRadius: params.edgeRadius,
      faceRadialSegments: params.faceRadialSegments,
      deformation,
    });

    const geometry = coinGenerator.generateGeometry();

    // Create or update mesh
    if (coinMesh) {
      coinMesh.geometry.dispose();
      coinMesh.geometry = geometry;
    } else {
      const material = new THREE.MeshStandardMaterial({
        color: params.color,
        metalness: params.metalness,
        roughness: params.roughness,
        envMapIntensity: 1.0,
      });

      coinMesh = new THREE.Mesh(geometry, material);
      coinMesh.castShadow = true;
      coinMesh.receiveShadow = true;
      scene.add(coinMesh);
    }

    // Position coin so it sits on the ground
    // The coin geometry goes from -thickness/2 to +thickness/2 in Y
    // So we need to offset by thickness/2 to put the bottom on the ground
    coinMesh.position.y = params.thickness / 2;
  } else {
    // Fast path: just update positions
    coinGenerator.updatePositions(coinMesh!.geometry, params.thickness, params.edgeRadius);
    coinMesh!.position.y = params.thickness / 2;
  }

  lastUpdateTime = performance.now() - startTime;
  updateStats();
}

/**
 * Update material properties
 */
function updateMaterial(): void {
  if (!coinMesh) return;
  const material = coinMesh.material as THREE.MeshStandardMaterial;
  material.color.set(params.color);
  material.metalness = params.metalness;
  material.roughness = params.roughness;
}

/**
 * Update stats display
 */
function updateStats(): void {
  if (!statsElement || !coinGenerator) return;

  const vertices = coinGenerator.getVertexCount();
  const triangles = coinGenerator.getTriangleCount();

  statsElement.textContent = `Vertices: ${vertices.toLocaleString()} | Triangles: ${triangles.toLocaleString()} | Update: ${lastUpdateTime.toFixed(2)}ms`;
}

/**
 * Initialize Three.js scene
 */
function initThreeJS(): void {
  const canvas = document.getElementById('canvas') as HTMLCanvasElement;
  const container = canvas.parentElement!;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const aspect = container.clientWidth / container.clientHeight;
  camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
  camera.position.set(30, 40, 30);

  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
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
  controls.target.set(0, 2, 0);

  // Add ground plane
  const planeGeometry = new THREE.PlaneGeometry(600, 600);
  const groundGradientTexture = new THREE.CanvasTexture(
    createGroundGradientTexture(1024, 0.2, 3.0, 0.8)
  );
  groundGradientTexture.needsUpdate = true;

  const planeMaterial = new THREE.MeshStandardMaterial({
    map: groundGradientTexture,
    roughness: 1.0,
    metalness: 0.0,
    envMapIntensity: 0.0,
  });
  groundPlane = new THREE.Mesh(planeGeometry, planeMaterial);
  groundPlane.rotation.x = -Math.PI / 2;
  groundPlane.position.y = 0;
  groundPlane.receiveShadow = true;
  groundPlane.castShadow = false;
  scene.add(groundPlane);

  // Set initial ground brightness
  groundPlane.material.color.setRGB(0.5, 0.5, 0.5);

  // Load HDRI environment
  const rgbeLoader = new RGBELoader();
  rgbeLoader.load('/softbox.hdr', function (hdrEquirect) {
    hdrEquirect.mapping = THREE.EquirectangularReflectionMapping;
    scene.environment = hdrEquirect;
    console.log('HDRI environment loaded');
  });

  // Lights
  ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
  scene.add(ambientLight);

  sideLight = new THREE.DirectionalLight(0xffffff, 3.0);
  sideLight.position.set(-20, 35, -20);
  sideLight.castShadow = true;
  sideLight.shadow.mapSize.width = 1024;
  sideLight.shadow.mapSize.height = 1024;
  sideLight.shadow.camera.near = 0.1;
  sideLight.shadow.camera.far = 200;
  sideLight.shadow.camera.left = -60;
  sideLight.shadow.camera.right = 60;
  sideLight.shadow.camera.top = 60;
  sideLight.shadow.camera.bottom = -60;
  sideLight.shadow.bias = -0.0001;
  sideLight.shadow.normalBias = 0.02;
  scene.add(sideLight);

  sideLight2 = new THREE.DirectionalLight(0xffffff, 3.0);
  sideLight2.position.set(20, 35, -20);
  sideLight2.castShadow = false;
  scene.add(sideLight2);

  fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
  fillLight.position.set(-30, 10, -10);
  scene.add(fillLight);

  // Single overhead point light (reduced from 5 for performance)
  const pointLight = new THREE.PointLight(0xffffff, 5.0, 100);
  pointLight.position.set(0, 18, 0);
  pointLight.castShadow = false;
  pointLight.decay = 2;
  scene.add(pointLight);
  pointLights.push(pointLight);

  // Post-processing
  composer = new EffectComposer(renderer);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // TAA disabled for performance - enable if needed for static renders
  // const taaPass = new TAARenderPass(scene, camera);
  // taaPass.sampleLevel = 3;
  // composer.addPass(taaPass);

  const smaaPass = new SMAAPass(
    container.clientWidth * window.devicePixelRatio,
    container.clientHeight * window.devicePixelRatio
  );
  smaaPass.enabled = true;
  composer.addPass(smaaPass);

  // Color grading
  const ColorGradingShader = {
    uniforms: {
      tDiffuse: { value: null },
      saturation: { value: 0.85 },
      contrast: { value: 0.9 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      precision mediump float;
      uniform sampler2D tDiffuse;
      uniform float saturation;
      uniform float contrast;
      varying vec2 vUv;

      vec3 adjustSaturation(vec3 color, float adjustment) {
        vec3 gray = vec3(dot(color, vec3(0.299, 0.587, 0.114)));
        return mix(gray, color, adjustment);
      }

      vec3 adjustContrast(vec3 color, float adjustment) {
        return (color - 0.5) * adjustment + 0.5;
      }

      void main() {
        vec4 color = texture2D(tDiffuse, vUv);
        color.rgb = adjustSaturation(color.rgb, saturation);
        color.rgb = adjustContrast(color.rgb, contrast);
        gl_FragColor = color;
      }
    `,
  };

  const colorGradingPass = new ShaderPass(ColorGradingShader);
  composer.addPass(colorGradingPass);

  // Handle resize
  window.addEventListener('resize', () => {
    const width = container.clientWidth;
    const height = container.clientHeight;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    if (composer) composer.setSize(width, height);
  });
}

/**
 * Setup GUI controls
 */
function setupGUI(): void {
  const gui = new GUI({ title: 'Coin Mesh Generator' });

  // Outline folder
  const outlineFolder = gui.addFolder('Outline Shape');
  outlineFolder
    .add(params, 'outlineType', ['circle', 'superellipse', 'blob', 'roundedRect'])
    .name('Type')
    .onChange(() => updateCoinMesh(true));

  // Circle params
  const circleFolder = outlineFolder.addFolder('Circle');
  circleFolder
    .add(params, 'circleRadius', 5, 20, 0.5)
    .name('Radius')
    .onChange(() => updateCoinMesh(true));

  // Superellipse params
  const superFolder = outlineFolder.addFolder('Superellipse');
  superFolder
    .add(params, 'superellipseA', 5, 20, 0.5)
    .name('Width')
    .onChange(() => updateCoinMesh(true));
  superFolder
    .add(params, 'superellipseB', 5, 20, 0.5)
    .name('Height')
    .onChange(() => updateCoinMesh(true));
  superFolder
    .add(params, 'superellipseN', 2, 8, 0.1)
    .name('Squareness')
    .onChange(() => updateCoinMesh(true));

  // Blob params
  const blobFolder = outlineFolder.addFolder('Blob');
  blobFolder
    .add(params, 'blobRadius', 5, 20, 0.5)
    .name('Base Radius')
    .onChange(() => updateCoinMesh(true));
  blobFolder
    .add(params, 'blobNoiseFreq', 1, 8, 1)
    .name('Noise Freq')
    .onChange(() => updateCoinMesh(true));
  blobFolder
    .add(params, 'blobNoiseAmp', 0, 0.4, 0.01)
    .name('Noise Amp')
    .onChange(() => updateCoinMesh(true));
  blobFolder
    .add(params, 'blobSeed', 1, 100, 1)
    .name('Seed')
    .onChange(() => updateCoinMesh(true));

  // Rounded rect params
  const rectFolder = outlineFolder.addFolder('Rounded Rect');
  rectFolder
    .add(params, 'rectWidth', 10, 40, 1)
    .name('Width')
    .onChange(() => updateCoinMesh(true));
  rectFolder
    .add(params, 'rectHeight', 10, 40, 1)
    .name('Height')
    .onChange(() => updateCoinMesh(true));
  rectFolder
    .add(params, 'rectCornerRadius', 0, 10, 0.5)
    .name('Corner Radius')
    .onChange(() => updateCoinMesh(true));

  // Coin dimensions folder
  const coinFolder = gui.addFolder('Coin Dimensions');
  coinFolder
    .add(params, 'thickness', 0.5, 10, 0.1)
    .name('Thickness')
    .onChange(() => updateCoinMesh(false)); // Fast path
  coinFolder
    .add(params, 'edgeRadius', 0.1, 3, 0.05)
    .name('Edge Radius')
    .onChange(() => updateCoinMesh(false)); // Fast path

  // Quality folder
  const qualityFolder = gui.addFolder('Quality');
  qualityFolder
    .add(params, 'quality', ['low', 'medium', 'high'])
    .name('Preset')
    .onChange((value: 'low' | 'medium' | 'high') => {
      const preset = QUALITY_PRESETS[value];
      params.outlineSamples = preset.outlineSamples;
      params.profileSegments = preset.profileSegments;
      params.faceRadialSegments = preset.faceRadialSegments;
      // Update the sliders
      qualityFolder.controllers.forEach((c) => c.updateDisplay());
      updateCoinMesh(true);
    });
  qualityFolder
    .add(params, 'outlineSamples', 16, 256, 8)
    .name('Outline Samples')
    .onChange(() => updateCoinMesh(true));
  qualityFolder
    .add(params, 'profileSegments', 4, 32, 2)
    .name('Profile Segments')
    .onChange(() => updateCoinMesh(true));
  qualityFolder
    .add(params, 'faceRadialSegments', 4, 64, 4)
    .name('Face Radial Segments')
    .onChange(() => updateCoinMesh(true));

  // Material folder
  const materialFolder = gui.addFolder('Material');
  materialFolder.addColor(params, 'color').name('Color').onChange(updateMaterial);
  materialFolder.add(params, 'metalness', 0, 1, 0.01).name('Metalness').onChange(updateMaterial);
  materialFolder.add(params, 'roughness', 0, 1, 0.01).name('Roughness').onChange(updateMaterial);

  // Deformation folder
  const deformFolder = gui.addFolder('Y Deformation');
  deformFolder
    .add(params, 'deformEnabled')
    .name('Enabled')
    .onChange(() => updateCoinMesh(true));
  deformFolder
    .add(params, 'deformAmplitude', 0, 3, 0.05)
    .name('Amplitude')
    .onChange(() => updateCoinMesh(true));
  deformFolder
    .add(params, 'deformFreqX', 0.01, 1, 0.01)
    .name('Frequency X')
    .onChange(() => updateCoinMesh(true));
  deformFolder
    .add(params, 'deformFreqZ', 0.01, 1, 0.01)
    .name('Frequency Z')
    .onChange(() => updateCoinMesh(true));
  deformFolder
    .add(params, 'deformPhaseX', -10, 10, 0.1)
    .name('Phase X')
    .onChange(() => updateCoinMesh(true));
  deformFolder
    .add(params, 'deformPhaseZ', -10, 10, 0.1)
    .name('Phase Z')
    .onChange(() => updateCoinMesh(true));
  deformFolder
    .add(params, 'deformOctaves', 1, 6, 1)
    .name('Octaves')
    .onChange(() => updateCoinMesh(true));
  deformFolder
    .add(params, 'deformPersistence', 0.1, 1, 0.05)
    .name('Persistence')
    .onChange(() => updateCoinMesh(true));
  deformFolder.open();

  // Rendering folder
  const renderFolder = gui.addFolder('Rendering');
  renderFolder
    .add(params, 'animateLights')
    .name('Animate Lights')
    .onChange((v: boolean) => (animateLights = v));

  // Open relevant folders
  outlineFolder.open();
  coinFolder.open();
}

/**
 * Animation loop
 */
function animate(): void {
  requestAnimationFrame(animate);
  controls.update();

  if (animateLights && sideLight && sideLight2) {
    animationTime += 0.016 * animationSpeed;
    const angle1 = animationTime;
    sideLight.position.x = initialLightPositions.light1.x + Math.cos(angle1) * 10;
    sideLight.position.z = initialLightPositions.light1.z + Math.sin(angle1) * 10;
    sideLight.position.y = initialLightPositions.light1.y + Math.sin(angle1 * 0.5) * 5;

    const angle2 = animationTime + Math.PI / 4;
    sideLight2.position.x = initialLightPositions.light2.x + Math.cos(angle2) * 10;
    sideLight2.position.z = initialLightPositions.light2.z + Math.sin(angle2) * 10;
    sideLight2.position.y = initialLightPositions.light2.y + Math.sin(angle2 * 0.5) * 5;
  }

  if (composer) {
    composer.render();
  } else {
    renderer.render(scene, camera);
  }
}

/**
 * Initialize the demo
 */
function init(): void {
  // Get stats element
  statsElement = document.getElementById('stats')!;

  // Initialize Three.js
  initThreeJS();

  // Setup GUI
  setupGUI();

  // Create initial coin
  updateCoinMesh(true);

  // Start animation loop
  animate();

  // Hide loading
  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');

  console.log('Coin Mesh Demo initialized');
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
