import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import { setOC, makeCylinder, drawCircle, draw } from 'replicad';
import opencascade from 'replicad-opencascadejs/src/replicad_single.js';
import opencascadeWasm from 'replicad-opencascadejs/src/replicad_single.wasm?url';

// Global variables
let scene, camera, renderer, controls;
let ringMesh = null;
let moonMesh = null;  // Separate mesh for the moon
let isInitialized = false;

// Animation variables
let isAnimating = false;
let animationStartTime = 0;
let animationStartAngle = 0;
let animationTargetAngle = 0;
let animationDuration = 2000; // 2 seconds in ms
let lastFrameTime = 0;
let frameCount = 0;
let totalBuildTime = 0;

// Dimensions (in mm) - will be updated from sliders
const RING_DIAMETER = 25;  // 1 inch = 25.4mm
let RING_WIDTH = 2.2;      // Default: 2.2mm
let HEIGHT = 1;            // Default: 1mm (shared for ring, sun, and moon)
let SUN_DIAMETER = 12;     // Default: 12mm
let SUN_THICKNESS = 2;     // Default: 2mm (sun width)
let MOON_DIAMETER = 8;     // Default: 8mm
let MOON_ANGLE = 180;      // Default: 180 degrees (opposite side from sun)
let FILLET_RADIUS = 0.3;   // Default: 0.3mm

// Initialize RepliCAD
async function initializeReplicad() {
    try {
        const OC = await opencascade({
            locateFile: () => opencascadeWasm,
        });

        setOC(OC);
        isInitialized = true;
        console.log('RepliCAD initialized successfully');
    } catch (error) {
        console.error('Failed to initialize RepliCAD:', error);
    }
}

// Create just the ring with sun (no moon - moon is separate)
async function createRingWithSun() {
    console.log('Creating ring with sun...');

    // Main flat ring (torus shape)
    const outerRadius = RING_DIAMETER / 2;
    const innerRadius = outerRadius - RING_WIDTH;

    // Create outer and inner cylinders for the main ring
    const outerCylinder = makeCylinder(outerRadius, HEIGHT);
    const innerCylinder = makeCylinder(innerRadius, HEIGHT);

    let mainRing = outerCylinder.cut(innerCylinder);
    console.log('Main ring created');

    // Calculate position on ring circumference
    const ringCenterlineRadius = (outerRadius + innerRadius) / 2;

    // === SUN ELEMENT (hollow) ===
    const sunPositionX = ringCenterlineRadius;
    const sunOuterRadius = SUN_DIAMETER / 2;
    const sunInnerRadius = sunOuterRadius - SUN_THICKNESS;

    // Create sun as a hollow ring
    const sunOuter = makeCylinder(sunOuterRadius, HEIGHT);
    const sunInner = makeCylinder(sunInnerRadius, HEIGHT);
    const sun = sunOuter.cut(sunInner);
    console.log('Sun element created');

    // Position the sun with its center on the ring's circumference
    const sunTranslated = sun.translate(sunPositionX, 0, 0);

    // Punch through the main ring with the sun's inner circle
    const sunPunchCylinder = makeCylinder(sunInnerRadius, HEIGHT);
    const sunPunchTranslated = sunPunchCylinder.translate(sunPositionX, 0, 0);

    mainRing = mainRing.cut(sunPunchTranslated);
    console.log('Punched hole for sun through main ring');

    // Fuse sun with the main ring
    let combinedShape = mainRing.fuse(sunTranslated);
    console.log('Sun fused with main ring');

    // Apply fillet to all edges
    if (FILLET_RADIUS > 0.01) {
        try {
            combinedShape = combinedShape.fillet(FILLET_RADIUS);
            console.log(`Applied fillet with radius ${FILLET_RADIUS.toFixed(3)}mm`);
        } catch (error) {
            console.warn('Fillet failed, trying with smaller radius:', error);
            try {
                const smallerRadius = FILLET_RADIUS * 0.5;
                combinedShape = combinedShape.fillet(smallerRadius);
                console.log(`Applied smaller fillet with radius ${smallerRadius.toFixed(3)}mm`);
            } catch (error2) {
                console.warn('Could not apply fillet, continuing without it:', error2);
            }
        }
    }

    return combinedShape;
}

// Create moon as separate geometry (at origin)
async function createMoonGeometry() {
    console.log('Creating moon geometry at origin...');
    const moonRadius = MOON_DIAMETER / 2;
    let moon = makeCylinder(moonRadius, HEIGHT);

    // Apply fillet to moon edges
    if (FILLET_RADIUS > 0.01) {
        try {
            moon = moon.fillet(FILLET_RADIUS);
            console.log(`Applied fillet to moon with radius ${FILLET_RADIUS.toFixed(3)}mm`);
        } catch (error) {
            console.warn('Moon fillet failed, trying with smaller radius:', error);
            try {
                const smallerRadius = FILLET_RADIUS * 0.5;
                moon = moon.fillet(smallerRadius);
                console.log(`Applied smaller fillet to moon with radius ${smallerRadius.toFixed(3)}mm`);
            } catch (error2) {
                console.warn('Could not apply fillet to moon, continuing without it:', error2);
            }
        }
    }

    console.log('Moon geometry created');
    return moon;
}

// Initialize Three.js scene
function initThreeJS() {
    const canvas = document.getElementById('canvas');
    const container = canvas.parentElement;

    // Scene setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    // Camera setup
    const aspect = container.clientWidth / container.clientHeight;
    camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    camera.position.set(50, 60, 50);

    // Renderer setup
    renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        antialias: true,
        powerPreference: "high-performance"
    });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Controls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0);

    // Add ground plane
    const planeGeometry = new THREE.PlaneGeometry(200, 200);
    const planeMaterial = new THREE.MeshStandardMaterial({
        color: 0x404040,
        roughness: 0.8,
        metalness: 0.2
    });
    const groundPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    groundPlane.rotation.x = -Math.PI / 2;
    groundPlane.position.y = -5;
    groundPlane.receiveShadow = true;
    scene.add(groundPlane);

    // Add lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const mainLight = new THREE.DirectionalLight(0xffffff, 1.5);
    mainLight.position.set(20, 30, 20);
    mainLight.castShadow = true;
    mainLight.shadow.mapSize.width = 2048;
    mainLight.shadow.mapSize.height = 2048;
    scene.add(mainLight);

    // Load HDRI environment
    const rgbeLoader = new RGBELoader();
    rgbeLoader.load('/softbox.hdr', function(hdrEquirect) {
        hdrEquirect.mapping = THREE.EquirectangularReflectionMapping;
        scene.environment = hdrEquirect;
        console.log('HDRI environment loaded');
    });

    // Handle window resize
    window.addEventListener('resize', () => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
    });

    // Start animation loop
    animate();
}

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

// Easing function: ease-in-out (starts slow, speeds up, slows down)
function easeInOutCubic(t) {
    return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Start animation test
function startAnimationTest() {
    if (isAnimating) {
        console.log('Animation already running');
        return;
    }

    if (!moonMesh) {
        console.log('Moon mesh not yet created. Please wait for initialization to complete.');
        return;
    }

    isAnimating = true;
    animationStartTime = performance.now();
    animationStartAngle = MOON_ANGLE;
    animationTargetAngle = MOON_ANGLE + 20; // Move 20 degrees
    frameCount = 0;
    totalBuildTime = 0;
    lastFrameTime = animationStartTime;

    console.log('=== ANIMATION TEST STARTED (Three.js Transform) ===');
    console.log(`Moving moon from ${animationStartAngle}° to ${animationTargetAngle}° over ${animationDuration}ms`);
    console.log('Using Three.js transforms - no RepliCAD rebuilds!');
    console.log('Target: 60 FPS (16.67ms per frame)');

    animateFrame();
}

// Animate a single frame using Three.js transforms (no RepliCAD rebuild)
function animateFrame() {
    if (!isAnimating) return;

    const currentTime = performance.now();
    const elapsed = currentTime - animationStartTime;
    const progress = Math.min(elapsed / animationDuration, 1.0);

    // Apply easing
    const easedProgress = easeInOutCubic(progress);

    // Calculate new angle
    const angleDelta = animationTargetAngle - animationStartAngle;
    MOON_ANGLE = animationStartAngle + (angleDelta * easedProgress);

    // Update UI
    document.getElementById('moonAngle').value = MOON_ANGLE;
    document.getElementById('moonAngle-value').textContent = MOON_ANGLE.toFixed(0) + '°';

    // Update moon position using Three.js transform (instant!)
    const transformStartTime = performance.now();
    updateMoonPosition();
    const transformTime = performance.now() - transformStartTime;

    frameCount++;

    const frameTime = currentTime - lastFrameTime;
    const fps = frameTime > 0 ? 1000 / frameTime : 0;
    lastFrameTime = currentTime;

    console.log(`Frame ${frameCount}: Angle=${MOON_ANGLE.toFixed(1)}° | Transform=${transformTime.toFixed(3)}ms | Frame=${frameTime.toFixed(1)}ms | FPS=${fps.toFixed(1)}`);

    // Continue animation or finish
    if (progress < 1.0) {
        requestAnimationFrame(animateFrame);
    } else {
        isAnimating = false;
        const totalTime = performance.now() - animationStartTime;
        const avgFPS = (frameCount / totalTime) * 1000;

        console.log('=== ANIMATION TEST COMPLETE ===');
        console.log(`Total frames: ${frameCount}`);
        console.log(`Total time: ${totalTime.toFixed(0)}ms`);
        console.log(`Average FPS: ${avgFPS.toFixed(1)}`);
        console.log(`Target achieved: ${avgFPS >= 30 ? '✓ 30+ FPS' : '✗ Below 30 FPS'}`);
        console.log(`60 FPS capable: ${avgFPS >= 60 ? '✓ YES' : '✗ NO'}`);
    }
}

// Create and add the ring to the scene
async function createAndDisplayRing() {
    try {
        if (!isAnimating) {
            document.getElementById('loading').classList.remove('hidden');
        }

        // Create the ring+sun shape using RepliCAD
        const buildStartTime = performance.now();
        const ringShape = await createRingWithSun();
        const buildTime = performance.now() - buildStartTime;

        if (!isAnimating) {
            console.log(`RepliCAD ring+sun build time: ${buildTime.toFixed(1)}ms`);
        }

        // Mesh the ring+sun shape
        console.log('Meshing ring+sun shape...');
        const meshed = ringShape.mesh({
            tolerance: 0.01,
            angularTolerance: 15
        });

        // Convert to Three.js geometry
        const vertices = new Float32Array(meshed.vertices);
        const indices = new Uint32Array(meshed.triangles);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();

        console.log(`Ring mesh created - Vertices: ${vertices.length / 3}, Triangles: ${indices.length / 3}`);

        // Create material
        const material = new THREE.MeshStandardMaterial({
            color: 0xFFD700,  // Gold
            metalness: 1.0,
            roughness: 0.2,
            envMapIntensity: 1.0
        });

        // Create mesh and add to scene
        if (ringMesh) {
            scene.remove(ringMesh);
            ringMesh.geometry.dispose();
        }

        ringMesh = new THREE.Mesh(geometry, material);
        ringMesh.rotation.x = Math.PI / 2;  // Lay flat
        ringMesh.castShadow = true;
        ringMesh.receiveShadow = true;
        scene.add(ringMesh);

        console.log('Ring+sun added to scene');

        // Create moon as separate mesh if it doesn't exist yet
        if (!moonMesh) {
            const moonBuildStart = performance.now();
            const moonGeometry = await createMoonGeometry();
            const moonBuildTime = performance.now() - moonBuildStart;
            console.log(`RepliCAD moon build time: ${moonBuildTime.toFixed(1)}ms`);

            // Mesh the moon
            console.log('Meshing moon...');
            const moonMeshed = moonGeometry.mesh({
                tolerance: 0.01,
                angularTolerance: 15
            });

            // Convert to Three.js geometry
            const moonVertices = new Float32Array(moonMeshed.vertices);
            const moonIndices = new Uint32Array(moonMeshed.triangles);

            const moonGeometryThree = new THREE.BufferGeometry();
            moonGeometryThree.setAttribute('position', new THREE.BufferAttribute(moonVertices, 3));
            moonGeometryThree.setIndex(new THREE.BufferAttribute(moonIndices, 1));
            moonGeometryThree.computeVertexNormals();

            console.log(`Moon mesh created - Vertices: ${moonVertices.length / 3}, Triangles: ${moonIndices.length / 3}`);

            // Create moon mesh with same material
            const moonMaterial = new THREE.MeshStandardMaterial({
                color: 0xFFD700,  // Gold
                metalness: 1.0,
                roughness: 0.2,
                envMapIntensity: 1.0
            });

            moonMesh = new THREE.Mesh(moonGeometryThree, moonMaterial);
            moonMesh.castShadow = true;
            moonMesh.receiveShadow = true;
            scene.add(moonMesh);

            console.log('Moon mesh created and added to scene');
        }

        // Position moon using Three.js transforms
        updateMoonPosition();

        document.getElementById('loading').classList.add('hidden');

    } catch (error) {
        console.error('Error creating ring:', error);
        document.getElementById('loading').classList.add('hidden');
        alert('Error: ' + error.message);
    }
}

// Update moon position using Three.js transforms (no RepliCAD rebuild)
function updateMoonPosition() {
    if (!moonMesh) return;

    // Calculate position on ring circumference
    const outerRadius = RING_DIAMETER / 2;
    const innerRadius = outerRadius - RING_WIDTH;
    const ringCenterlineRadius = (outerRadius + innerRadius) / 2;

    // Convert angle to radians
    const angleRad = (MOON_ANGLE * Math.PI) / 180;

    // Calculate X, Z position on the ring circumference (Y is vertical)
    const x = ringCenterlineRadius * Math.cos(angleRad);
    const z = ringCenterlineRadius * Math.sin(angleRad);

    // Position moon at the calculated position
    moonMesh.position.set(x, 0, z);

    // Rotate to lay flat like the ring
    moonMesh.rotation.set(Math.PI / 2, 0, 0);

    console.log(`Moon positioned at angle ${MOON_ANGLE.toFixed(0)}° (x=${x.toFixed(2)}, z=${z.toFixed(2)})`);
}

// Preset management functions
function savePreset() {
    const presetName = document.getElementById('presetName').value.trim();
    if (!presetName) {
        alert('Please enter a preset name');
        return;
    }

    const preset = {
        ringWidth: RING_WIDTH,
        height: HEIGHT,
        sunDiameter: SUN_DIAMETER,
        sunWidth: SUN_THICKNESS,
        moonDiameter: MOON_DIAMETER,
        moonAngle: MOON_ANGLE,
        filletRadius: FILLET_RADIUS
    };

    // Get existing presets from localStorage
    const presets = JSON.parse(localStorage.getItem('sunRingPresets') || '{}');
    presets[presetName] = preset;
    localStorage.setItem('sunRingPresets', JSON.stringify(presets));

    // Update the preset list
    updatePresetList();

    // Clear the input and select the new preset
    document.getElementById('presetName').value = '';
    document.getElementById('presetList').value = presetName;

    console.log(`Preset "${presetName}" saved:`, preset);
}

function loadPreset() {
    const presetName = document.getElementById('presetList').value;
    if (!presetName) {
        alert('Please select a preset to load');
        return;
    }

    const presets = JSON.parse(localStorage.getItem('sunRingPresets') || '{}');
    const preset = presets[presetName];

    if (!preset) {
        alert('Preset not found');
        return;
    }

    // Update global variables
    RING_WIDTH = preset.ringWidth;
    HEIGHT = preset.height || preset.ringHeight || 1;  // Handle old presets
    SUN_DIAMETER = preset.sunDiameter;
    SUN_THICKNESS = preset.sunWidth;
    MOON_DIAMETER = preset.moonDiameter || 8;
    MOON_ANGLE = preset.moonAngle || 180;
    FILLET_RADIUS = preset.filletRadius || 0.3;

    // Update slider values and displays
    document.getElementById('ringWidth').value = RING_WIDTH;
    document.getElementById('ringWidth-value').textContent = RING_WIDTH.toFixed(1) + ' mm';

    document.getElementById('height').value = HEIGHT;
    document.getElementById('height-value').textContent = HEIGHT.toFixed(1) + ' mm';

    document.getElementById('sunDiameter').value = SUN_DIAMETER;
    document.getElementById('sunDiameter-value').textContent = SUN_DIAMETER.toFixed(1) + ' mm';

    document.getElementById('sunWidth').value = SUN_THICKNESS;
    document.getElementById('sunWidth-value').textContent = SUN_THICKNESS.toFixed(1) + ' mm';

    document.getElementById('moonDiameter').value = MOON_DIAMETER;
    document.getElementById('moonDiameter-value').textContent = MOON_DIAMETER.toFixed(1) + ' mm';

    document.getElementById('moonAngle').value = MOON_ANGLE;
    document.getElementById('moonAngle-value').textContent = MOON_ANGLE.toFixed(0) + '°';

    document.getElementById('filletRadius').value = FILLET_RADIUS;
    document.getElementById('filletRadius-value').textContent = FILLET_RADIUS.toFixed(1) + ' mm';

    // Recreate the ring
    if (isInitialized) {
        createAndDisplayRing();
    }

    console.log(`Preset "${presetName}" loaded:`, preset);
}

function deletePreset() {
    const presetName = document.getElementById('presetList').value;
    if (!presetName) {
        alert('Please select a preset to delete');
        return;
    }

    if (!confirm(`Delete preset "${presetName}"?`)) {
        return;
    }

    const presets = JSON.parse(localStorage.getItem('sunRingPresets') || '{}');
    delete presets[presetName];
    localStorage.setItem('sunRingPresets', JSON.stringify(presets));

    updatePresetList();
    console.log(`Preset "${presetName}" deleted`);
}

function updatePresetList() {
    const presets = JSON.parse(localStorage.getItem('sunRingPresets') || '{}');
    const select = document.getElementById('presetList');

    // Clear existing options except the first one
    select.innerHTML = '<option value="">-- Select Preset --</option>';

    // Add preset options
    Object.keys(presets).sort().forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });
}

function setupPresetButtons() {
    document.getElementById('savePreset').addEventListener('click', savePreset);
    document.getElementById('loadPreset').addEventListener('click', loadPreset);
    document.getElementById('deletePreset').addEventListener('click', deletePreset);

    // Allow Enter key to save preset
    document.getElementById('presetName').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            savePreset();
        }
    });

    // Load presets on startup
    updatePresetList();
}

// Rebuild just the moon mesh (when diameter changes)
async function rebuildMoonMesh() {
    try {
        console.log('Rebuilding moon mesh...');

        // Remove old moon mesh
        if (moonMesh) {
            scene.remove(moonMesh);
            moonMesh.geometry.dispose();
            moonMesh.material.dispose();
            moonMesh = null;
        }

        // Create new moon geometry
        const moonGeometry = await createMoonGeometry();

        // Mesh the moon
        const moonMeshed = moonGeometry.mesh({
            tolerance: 0.01,
            angularTolerance: 15
        });

        // Convert to Three.js geometry
        const moonVertices = new Float32Array(moonMeshed.vertices);
        const moonIndices = new Uint32Array(moonMeshed.triangles);

        const moonGeometryThree = new THREE.BufferGeometry();
        moonGeometryThree.setAttribute('position', new THREE.BufferAttribute(moonVertices, 3));
        moonGeometryThree.setIndex(new THREE.BufferAttribute(moonIndices, 1));
        moonGeometryThree.computeVertexNormals();

        // Create moon mesh with same material
        const moonMaterial = new THREE.MeshStandardMaterial({
            color: 0xFFD700,  // Gold
            metalness: 1.0,
            roughness: 0.2,
            envMapIntensity: 1.0
        });

        moonMesh = new THREE.Mesh(moonGeometryThree, moonMaterial);
        moonMesh.castShadow = true;
        moonMesh.receiveShadow = true;
        scene.add(moonMesh);

        // Position it
        updateMoonPosition();

        console.log('Moon mesh rebuilt');
    } catch (error) {
        console.error('Error rebuilding moon mesh:', error);
    }
}

// Setup slider event listeners
function setupSliders() {
    const sliders = [
        { id: 'ringWidth', variable: 'RING_WIDTH', suffix: ' mm', updateType: 'ring' },
        { id: 'height', variable: 'HEIGHT', suffix: ' mm', updateType: 'both' },
        { id: 'sunDiameter', variable: 'SUN_DIAMETER', suffix: ' mm', updateType: 'ring' },
        { id: 'sunWidth', variable: 'SUN_THICKNESS', suffix: ' mm', updateType: 'ring' },
        { id: 'moonDiameter', variable: 'MOON_DIAMETER', suffix: ' mm', updateType: 'moon' },
        { id: 'moonAngle', variable: 'MOON_ANGLE', suffix: '°', updateType: 'transform' },
        { id: 'filletRadius', variable: 'FILLET_RADIUS', suffix: ' mm', updateType: 'both' }  // Fillet affects both ring and moon
    ];

    sliders.forEach(({ id, variable, suffix, updateType }) => {
        const slider = document.getElementById(id);
        const valueDisplay = document.getElementById(id + '-value');

        slider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            const decimals = (suffix === '°') ? 0 : 1;
            valueDisplay.textContent = value.toFixed(decimals) + suffix;

            // Update the global variable
            if (variable === 'RING_WIDTH') RING_WIDTH = value;
            else if (variable === 'HEIGHT') HEIGHT = value;
            else if (variable === 'SUN_DIAMETER') SUN_DIAMETER = value;
            else if (variable === 'SUN_THICKNESS') SUN_THICKNESS = value;
            else if (variable === 'MOON_DIAMETER') MOON_DIAMETER = value;
            else if (variable === 'MOON_ANGLE') MOON_ANGLE = value;
            else if (variable === 'FILLET_RADIUS') FILLET_RADIUS = value;

            if (isInitialized) {
                if (updateType === 'ring') {
                    // Rebuild ring+sun only
                    createAndDisplayRing();
                } else if (updateType === 'moon') {
                    // Rebuild moon mesh only
                    rebuildMoonMesh();
                } else if (updateType === 'both') {
                    // Rebuild everything (height affects both)
                    createAndDisplayRing();
                } else if (updateType === 'transform') {
                    // Just update moon position (fast Three.js transform)
                    updateMoonPosition();
                }
            }
        });
    });
}

// Main initialization
async function initializeApp() {
    console.log('Starting initialization...');

    // Initialize RepliCAD
    await initializeReplicad();

    // Initialize Three.js
    initThreeJS();

    // Setup sliders
    setupSliders();

    // Setup preset buttons
    setupPresetButtons();

    // Create and display the ring
    if (isInitialized) {
        await createAndDisplayRing();
    }

    console.log('Initialization complete');
}

// Start the application
initializeApp().catch(error => {
    console.error('Failed to initialize application:', error);
});

// Expose animation test function globally for the button
window.startAnimationTest = startAnimationTest;
