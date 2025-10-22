import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import { setOC, makeCylinder, drawCircle, draw } from 'replicad';
import opencascade from 'replicad-opencascadejs/src/replicad_single.js';
import opencascadeWasm from 'replicad-opencascadejs/src/replicad_single.wasm?url';

// Global variables
let scene, camera, renderer, controls;
let ringMesh = null;
let isInitialized = false;

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

// Create the sun ring with hollow center and moon
async function createSunRingShape() {
    console.log('Creating sun ring jewelry...');

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

    // === MOON ELEMENT (solid) ===
    // Calculate moon position based on angle
    const moonAngleRad = (MOON_ANGLE * Math.PI) / 180;
    const moonPositionX = ringCenterlineRadius * Math.cos(moonAngleRad);
    const moonPositionY = ringCenterlineRadius * Math.sin(moonAngleRad);

    // Create moon as a solid cylinder
    const moonRadius = MOON_DIAMETER / 2;
    const moon = makeCylinder(moonRadius, HEIGHT);
    console.log('Moon element created');

    // Position the moon
    const moonTranslated = moon.translate(moonPositionX, moonPositionY, 0);

    // Punch through the main ring where the moon will be
    const moonPunchCylinder = makeCylinder(moonRadius, HEIGHT);
    const moonPunchTranslated = moonPunchCylinder.translate(moonPositionX, moonPositionY, 0);

    mainRing = mainRing.cut(moonPunchTranslated);
    console.log('Punched hole for moon through main ring');

    // Fuse sun and moon with the main ring
    let combinedShape = mainRing.fuse(sunTranslated);
    combinedShape = combinedShape.fuse(moonTranslated);
    console.log('Sun and moon fused with main ring');

    // Apply fillet to all edges - this will round the top and bottom faces
    if (FILLET_RADIUS > 0.01) {  // Only apply if radius is meaningful
        try {
            combinedShape = combinedShape.fillet(FILLET_RADIUS);
            console.log(`Applied fillet with radius ${FILLET_RADIUS.toFixed(3)}mm`);
        } catch (error) {
            console.warn('Fillet failed, trying with smaller radius:', error);
            try {
                // Try with a smaller radius if the first attempt fails
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

// Create and add the ring to the scene
async function createAndDisplayRing() {
    try {
        document.getElementById('loading').classList.remove('hidden');

        // Create the shape using RepliCAD
        const shape = await createSunRingShape();

        // Mesh the shape
        console.log('Meshing shape...');
        const meshed = shape.mesh({
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

        console.log(`Mesh created - Vertices: ${vertices.length / 3}, Triangles: ${indices.length / 3}`);

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

        console.log('Ring added to scene');
        document.getElementById('loading').classList.add('hidden');

    } catch (error) {
        console.error('Error creating ring:', error);
        document.getElementById('loading').classList.add('hidden');
        alert('Error: ' + error.message);
    }
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

// Setup slider event listeners
function setupSliders() {
    const sliders = [
        { id: 'ringWidth', variable: 'RING_WIDTH', suffix: ' mm' },
        { id: 'height', variable: 'HEIGHT', suffix: ' mm' },
        { id: 'sunDiameter', variable: 'SUN_DIAMETER', suffix: ' mm' },
        { id: 'sunWidth', variable: 'SUN_THICKNESS', suffix: ' mm' },
        { id: 'moonDiameter', variable: 'MOON_DIAMETER', suffix: ' mm' },
        { id: 'moonAngle', variable: 'MOON_ANGLE', suffix: '°' },
        { id: 'filletRadius', variable: 'FILLET_RADIUS', suffix: ' mm' }
    ];

    sliders.forEach(({ id, variable, suffix }) => {
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

            // Recreate the ring with new parameters
            if (isInitialized) {
                createAndDisplayRing();
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
