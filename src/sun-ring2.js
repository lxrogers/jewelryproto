import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass';
import { TAARenderPass } from 'three/examples/jsm/postprocessing/TAARenderPass';
import { VignetteShader } from 'three/examples/jsm/shaders/VignetteShader';
import { setOC, makeCylinder } from 'replicad';
import opencascade from 'replicad-opencascadejs/src/replicad_single.js';
import opencascadeWasm from 'replicad-opencascadejs/src/replicad_single.wasm?url';

// Global variables
let scene, camera, renderer, controls;
let composer = null;
let smaaPass = null;
let taaPass = null;
let vignettePass = null;
let colorGradingPass = null;
let ringMesh = null;
let moonMesh = null;
let groundPlane = null;
let contactShadow = null;
let isInitialized = false;

// Light references
let ambientLight = null;
let sideLight = null;
let sideLight2 = null;
let fillLight = null;
let pointLights = [];
let hdrEnvironment = null;
let environmentIntensity = 1.0;

// Animation settings
let animateLights = true;
let animationSpeed = 0.1;
let animationTime = 0;
let initialLightPositions = {
    light1: { x: -20, y: 35, z: -20 },
    light2: { x: 20, y: 35, z: -20 }
};

// Jewelry dimensions (in mm)
const RING_DIAMETER = 25;
let RING_WIDTH = 1.5;
let HEIGHT = 1;
let SUN_DIAMETER = 7.5;
let SUN_THICKNESS = 1.4;
let MOON_DIAMETER = 4.0;
let MOON_ANGLE = 180;
let MOON_HEIGHT = 1.0;  // Separate height for moon
let FILLET_RADIUS = 0.3;

// Animation test variables
let isAnimating = false;
let animationStartTime = 0;
let animationStartAngle = 0;
let animationTargetAngle = 0;
let animationDuration = 2000; // 2 seconds
let animationDegrees = 360; // Default full rotation

// Create radial gradient texture for ground plane
function createGroundGradientTexture(size = 1024, middleStop = 0.5, endStop = 0.8, intensity = 0.8) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');

    const centerX = size / 2;
    const centerY = size / 2;
    const maxRadius = size / 2;

    const gradient = context.createRadialGradient(centerX, centerY, 0, centerX, centerY, maxRadius * endStop);

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

// Create contact shadow texture
function createContactShadowTexture(size = 512, innerRatio = 0.7, outerRatio = 1.0) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const context = canvas.getContext('2d');

    const centerX = size / 2;
    const centerY = size / 2;
    const maxRadius = size / 2;

    const imageData = context.createImageData(size, size);
    const data = imageData.data;

    const ringWidth = outerRatio - innerRatio;
    const blurAmount = ringWidth * 0.3;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const dx = x - centerX;
            const dy = y - centerY;
            const distance = Math.sqrt(dx * dx + dy * dy);
            const normalizedDistance = distance / maxRadius;

            const index = (y * size + x) * 4;
            let alpha = 0;

            const innerBlurStart = innerRatio - blurAmount;
            const innerBlurEnd = innerRatio + blurAmount;
            const outerBlurStart = outerRatio - blurAmount;
            const outerBlurEnd = outerRatio + blurAmount;

            if (normalizedDistance < innerBlurStart) {
                alpha = 0;
            } else if (normalizedDistance >= innerBlurStart && normalizedDistance < innerBlurEnd) {
                const blurPosition = (normalizedDistance - innerBlurStart) / (blurAmount * 2);
                alpha = Math.min(1.0, blurPosition * 2) * 0.8;
            } else if (normalizedDistance >= innerBlurEnd && normalizedDistance < outerBlurStart) {
                alpha = 0.8;
            } else if (normalizedDistance >= outerBlurStart && normalizedDistance < outerBlurEnd) {
                const blurPosition = (normalizedDistance - outerBlurStart) / (blurAmount * 2);
                alpha = Math.max(0, (1.0 - blurPosition) * 2) * 0.8;
            } else {
                alpha = 0;
            }

            data[index] = 0;
            data[index + 1] = 0;
            data[index + 2] = 0;
            data[index + 3] = alpha * 255;
        }
    }

    context.putImageData(imageData, 0, 0);
    return canvas;
}

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

// Create ring with sun (no moon - moon is separate)
async function createRingWithSun() {
    console.log('Creating ring with sun...');

    const outerRadius = RING_DIAMETER / 2;
    const innerRadius = outerRadius - RING_WIDTH;

    const outerCylinder = makeCylinder(outerRadius, HEIGHT);
    const innerCylinder = makeCylinder(innerRadius, HEIGHT);

    let mainRing = outerCylinder.cut(innerCylinder);
    console.log('Main ring created');

    const ringCenterlineRadius = (outerRadius + innerRadius) / 2;

    // === SUN ELEMENT (hollow) ===
    const sunPositionX = ringCenterlineRadius;
    const sunOuterRadius = SUN_DIAMETER / 2;
    const sunInnerRadius = sunOuterRadius - SUN_THICKNESS;

    const sunOuter = makeCylinder(sunOuterRadius, HEIGHT);
    const sunInner = makeCylinder(sunInnerRadius, HEIGHT);
    const sun = sunOuter.cut(sunInner);
    console.log('Sun element created');

    const sunTranslated = sun.translate(sunPositionX, 0, 0);

    // Punch through the main ring
    const sunPunchCylinder = makeCylinder(sunInnerRadius, HEIGHT);
    const sunPunchTranslated = sunPunchCylinder.translate(sunPositionX, 0, 0);

    mainRing = mainRing.cut(sunPunchTranslated);
    console.log('Punched hole for sun through main ring');

    let combinedShape = mainRing.fuse(sunTranslated);
    console.log('Sun fused with main ring');

    // Apply fillet
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
    let moon = makeCylinder(moonRadius, MOON_HEIGHT);

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

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000000);

    const aspect = container.clientWidth / container.clientHeight;
    camera = new THREE.PerspectiveCamera(45, aspect, 0.1, 1000);
    camera.position.set(50, 60, 50);

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

    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.target.set(0, 0, 0);

    // Add ground plane
    const planeGeometry = new THREE.PlaneGeometry(600, 600);
    const groundGradientTexture = new THREE.CanvasTexture(createGroundGradientTexture(1024, 0.2, 3.0, 0.8));
    groundGradientTexture.needsUpdate = true;

    const planeMaterial = new THREE.MeshStandardMaterial({
        map: groundGradientTexture,
        roughness: 1.0,
        metalness: 0.0,
        envMapIntensity: 0.0
    });
    groundPlane = new THREE.Mesh(planeGeometry, planeMaterial);
    groundPlane.rotation.x = -Math.PI / 2;
    groundPlane.position.y = 0;  // Ground at y=0
    groundPlane.receiveShadow = true;
    groundPlane.castShadow = false;
    scene.add(groundPlane);

    // Set initial ground brightness
    groundPlane.material.color.setRGB(0.5, 0.5, 0.5);

    // Contact shadow removed per user request

    // Load HDRI environment
    const rgbeLoader = new RGBELoader();
    rgbeLoader.load('/softbox.hdr', function(hdrEquirect) {
        hdrEquirect.mapping = THREE.EquirectangularReflectionMapping;
        hdrEnvironment = hdrEquirect;
        scene.environment = hdrEquirect;
        console.log('HDRI environment loaded');
    });

    // Lights
    ambientLight = new THREE.AmbientLight(0xffffff, 0.1);
    scene.add(ambientLight);

    sideLight = new THREE.DirectionalLight(0xffffff, 3.0);
    sideLight.position.set(-20, 35, -20);
    sideLight.castShadow = true;
    sideLight.shadow.mapSize.width = 4096;
    sideLight.shadow.mapSize.height = 4096;
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
    sideLight2.castShadow = true;
    sideLight2.shadow.mapSize.width = 4096;
    sideLight2.shadow.mapSize.height = 4096;
    sideLight2.shadow.camera.near = 0.1;
    sideLight2.shadow.camera.far = 200;
    sideLight2.shadow.camera.left = -60;
    sideLight2.shadow.camera.right = 60;
    sideLight2.shadow.camera.top = 60;
    sideLight2.shadow.camera.bottom = -60;
    sideLight2.shadow.bias = -0.0001;
    sideLight2.shadow.normalBias = 0.02;
    scene.add(sideLight2);

    fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-30, 10, -10);
    scene.add(fillLight);

    // Point lights
    const pointLightPositions = [
        { x: 12, y: 15, z: 12 },
        { x: -12, y: 15, z: 12 },
        { x: 0, y: 18, z: 0 },
        { x: 12, y: 12, z: -12 },
        { x: -12, y: 12, z: -12 }
    ];

    pointLightPositions.forEach((pos) => {
        const pointLight = new THREE.PointLight(0xffffff, 3.0, 100);
        pointLight.position.set(pos.x, pos.y, pos.z);
        pointLight.castShadow = false;
        pointLight.decay = 2;
        scene.add(pointLight);
        pointLights.push(pointLight);
    });

    // Post-processing
    composer = new EffectComposer(renderer);

    const renderPass = new RenderPass(scene, camera);
    composer.addPass(renderPass);

    taaPass = new TAARenderPass(scene, camera);
    taaPass.sampleLevel = 3;
    composer.addPass(taaPass);

    smaaPass = new SMAAPass(
        container.clientWidth * window.devicePixelRatio,
        container.clientHeight * window.devicePixelRatio
    );
    smaaPass.enabled = false;
    composer.addPass(smaaPass);

    // Color grading
    const ColorGradingShader = {
        uniforms: {
            'tDiffuse': { value: null },
            'saturation': { value: 0.85 },
            'contrast': { value: 0.90 }
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
        `
    };

    colorGradingPass = new ShaderPass(ColorGradingShader);
    composer.addPass(colorGradingPass);

    vignettePass = new ShaderPass(VignetteShader);
    vignettePass.uniforms['darkness'].value = 1.2;
    vignettePass.uniforms['offset'].value = 0.9;
    vignettePass.enabled = false;
    vignettePass.renderToScreen = true;
    composer.addPass(vignettePass);

    // Handle resize
    window.addEventListener('resize', () => {
        const width = container.clientWidth;
        const height = container.clientHeight;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height);
        if (composer) composer.setSize(width, height);
    });

    // Start animation
    animate();
}

// Animation loop
function animate() {
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

// Create and display jewelry
async function createAndDisplayJewelry() {
    try {
        document.getElementById('loading').classList.remove('hidden');

        // Create ring+sun
        const ringShape = await createRingWithSun();
        const meshed = ringShape.mesh({
            tolerance: 0.001,
            angularTolerance: 3
        });

        const vertices = new Float32Array(meshed.vertices);
        const indices = new Uint32Array(meshed.triangles);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        geometry.computeVertexNormals();

        const material = new THREE.MeshStandardMaterial({
            color: 0xFFD700,
            metalness: 1.0,
            roughness: 0.2,
            envMapIntensity: 1.0
        });

        if (ringMesh) {
            scene.remove(ringMesh);
            ringMesh.geometry.dispose();
        }

        ringMesh = new THREE.Mesh(geometry, material);
        ringMesh.rotation.x = Math.PI / 2;
        ringMesh.position.y = HEIGHT / 2;  // Raise by half height so bottom touches ground
        ringMesh.castShadow = true;
        ringMesh.receiveShadow = true;
        scene.add(ringMesh);

        // Create moon if it doesn't exist
        if (!moonMesh) {
            const moonGeometry = await createMoonGeometry();
            const moonMeshed = moonGeometry.mesh({
                tolerance: 0.001,
                angularTolerance: 3
            });

            const moonVertices = new Float32Array(moonMeshed.vertices);
            const moonIndices = new Uint32Array(moonMeshed.triangles);

            const moonGeometryThree = new THREE.BufferGeometry();
            moonGeometryThree.setAttribute('position', new THREE.BufferAttribute(moonVertices, 3));
            moonGeometryThree.setIndex(new THREE.BufferAttribute(moonIndices, 1));
            moonGeometryThree.computeVertexNormals();

            const moonMaterial = new THREE.MeshStandardMaterial({
                color: 0xFFD700,
                metalness: 1.0,
                roughness: 0.2,
                envMapIntensity: 1.0
            });

            moonMesh = new THREE.Mesh(moonGeometryThree, moonMaterial);
            moonMesh.castShadow = true;
            moonMesh.receiveShadow = true;
            scene.add(moonMesh);
        }

        updateMoonPosition();

        document.getElementById('loading').classList.add('hidden');
    } catch (error) {
        console.error('Error creating jewelry:', error);
        document.getElementById('loading').classList.add('hidden');
        alert('Error: ' + error.message);
    }
}

// Rebuild moon mesh
async function rebuildMoonMesh() {
    try {
        console.log('Rebuilding moon mesh...');

        if (moonMesh) {
            scene.remove(moonMesh);
            moonMesh.geometry.dispose();
            moonMesh.material.dispose();
            moonMesh = null;
        }

        const moonGeometry = await createMoonGeometry();
        const moonMeshed = moonGeometry.mesh({
            tolerance: 0.001,
            angularTolerance: 3
        });

        const moonVertices = new Float32Array(moonMeshed.vertices);
        const moonIndices = new Uint32Array(moonMeshed.triangles);

        const moonGeometryThree = new THREE.BufferGeometry();
        moonGeometryThree.setAttribute('position', new THREE.BufferAttribute(moonVertices, 3));
        moonGeometryThree.setIndex(new THREE.BufferAttribute(moonIndices, 1));
        moonGeometryThree.computeVertexNormals();

        const moonMaterial = new THREE.MeshStandardMaterial({
            color: 0xFFD700,
            metalness: 1.0,
            roughness: 0.2,
            envMapIntensity: 1.0
        });

        moonMesh = new THREE.Mesh(moonGeometryThree, moonMaterial);
        moonMesh.castShadow = true;
        moonMesh.receiveShadow = true;
        scene.add(moonMesh);

        updateMoonPosition();
        console.log('Moon mesh rebuilt');
    } catch (error) {
        console.error('Error rebuilding moon mesh:', error);
    }
}

// Update moon position using Three.js transforms
function updateMoonPosition() {
    if (!moonMesh) return;

    const outerRadius = RING_DIAMETER / 2;
    const innerRadius = outerRadius - RING_WIDTH;
    const ringCenterlineRadius = (outerRadius + innerRadius) / 2;

    const angleRad = (MOON_ANGLE * Math.PI) / 180;
    const x = ringCenterlineRadius * Math.cos(angleRad);
    const z = ringCenterlineRadius * Math.sin(angleRad);

    moonMesh.position.set(x, MOON_HEIGHT / 2, z);  // Raise by half moon height so bottom touches ground
    moonMesh.rotation.set(Math.PI / 2, 0, 0);
}

// Easing function: ease-in-out cubic
function easeInOutCubic(t) {
    return t < 0.5
        ? 4 * t * t * t
        : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// Start animation
function startAnimation() {
    if (isAnimating) {
        console.log('Animation already running');
        return;
    }

    if (!moonMesh) {
        console.log('Moon mesh not yet created');
        return;
    }

    isAnimating = true;
    animationStartTime = performance.now();
    animationStartAngle = MOON_ANGLE;
    animationTargetAngle = MOON_ANGLE + animationDegrees;

    console.log(`=== ANIMATION STARTED ===`);
    console.log(`Moving moon from ${animationStartAngle}° to ${animationTargetAngle}° (${animationDegrees}°)`);

    animateFrame();
}

// Animate a single frame
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
    const slider = document.getElementById('moonAngle');
    const valueDisplay = document.getElementById('moonAngle-value');
    if (slider) slider.value = MOON_ANGLE;
    if (valueDisplay) valueDisplay.textContent = MOON_ANGLE.toFixed(0) + '°';

    // Update moon position
    updateMoonPosition();

    // Continue animation or finish
    if (progress < 1.0) {
        requestAnimationFrame(animateFrame);
    } else {
        isAnimating = false;
        console.log('=== ANIMATION COMPLETE ===');
    }
}

// Preset management
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
        moonHeight: MOON_HEIGHT,
        filletRadius: FILLET_RADIUS
    };

    const presets = JSON.parse(localStorage.getItem('sunRing2Presets') || '{}');
    presets[presetName] = preset;
    localStorage.setItem('sunRing2Presets', JSON.stringify(presets));

    updatePresetList();
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

    const presets = JSON.parse(localStorage.getItem('sunRing2Presets') || '{}');
    const preset = presets[presetName];

    if (!preset) {
        alert('Preset not found');
        return;
    }

    // Update global variables
    RING_WIDTH = preset.ringWidth;
    HEIGHT = preset.height;
    SUN_DIAMETER = preset.sunDiameter;
    SUN_THICKNESS = preset.sunWidth;
    MOON_DIAMETER = preset.moonDiameter;
    MOON_ANGLE = preset.moonAngle;
    MOON_HEIGHT = preset.moonHeight || HEIGHT;  // Fallback to HEIGHT for old presets
    FILLET_RADIUS = preset.filletRadius;

    // Update sliders
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

    document.getElementById('moonHeight').value = MOON_HEIGHT;
    document.getElementById('moonHeight-value').textContent = MOON_HEIGHT.toFixed(2) + ' mm';

    document.getElementById('filletRadius').value = FILLET_RADIUS;
    document.getElementById('filletRadius-value').textContent = FILLET_RADIUS.toFixed(2) + ' mm';

    // Recreate jewelry
    if (isInitialized) {
        createAndDisplayJewelry();
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

    const presets = JSON.parse(localStorage.getItem('sunRing2Presets') || '{}');
    delete presets[presetName];
    localStorage.setItem('sunRing2Presets', JSON.stringify(presets));

    updatePresetList();
    console.log(`Preset "${presetName}" deleted`);
}

function updatePresetList() {
    const presets = JSON.parse(localStorage.getItem('sunRing2Presets') || '{}');
    const select = document.getElementById('presetList');

    select.innerHTML = '<option value="">-- Select Preset --</option>';

    Object.keys(presets).sort().forEach(name => {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        select.appendChild(option);
    });
}

function setupPresetButtons() {
    const saveBtn = document.getElementById('savePreset');
    const loadBtn = document.getElementById('loadPreset');
    const deleteBtn = document.getElementById('deletePreset');

    if (saveBtn) saveBtn.addEventListener('click', savePreset);
    if (loadBtn) loadBtn.addEventListener('click', loadPreset);
    if (deleteBtn) deleteBtn.addEventListener('click', deletePreset);

    const presetInput = document.getElementById('presetName');
    if (presetInput) {
        presetInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') savePreset();
        });
    }

    updatePresetList();
}

// Setup sliders
function setupSliders() {
    const sliders = [
        { id: 'ringWidth', variable: 'RING_WIDTH', suffix: ' mm', updateType: 'ring', decimals: 1 },
        { id: 'height', variable: 'HEIGHT', suffix: ' mm', updateType: 'both', decimals: 1 },
        { id: 'sunDiameter', variable: 'SUN_DIAMETER', suffix: ' mm', updateType: 'ring', decimals: 1 },
        { id: 'sunWidth', variable: 'SUN_THICKNESS', suffix: ' mm', updateType: 'ring', decimals: 1 },
        { id: 'moonDiameter', variable: 'MOON_DIAMETER', suffix: ' mm', updateType: 'moon', decimals: 1 },
        { id: 'moonAngle', variable: 'MOON_ANGLE', suffix: '°', updateType: 'transform', decimals: 0 },
        { id: 'moonHeight', variable: 'MOON_HEIGHT', suffix: ' mm', updateType: 'moon', decimals: 2 },
        { id: 'filletRadius', variable: 'FILLET_RADIUS', suffix: ' mm', updateType: 'both', decimals: 2 }
    ];

    sliders.forEach(({ id, variable, suffix, updateType, decimals }) => {
        const slider = document.getElementById(id);
        const valueDisplay = document.getElementById(id + '-value');

        if (!slider) return;

        slider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            valueDisplay.textContent = value.toFixed(decimals) + suffix;

            if (variable === 'RING_WIDTH') RING_WIDTH = value;
            else if (variable === 'HEIGHT') HEIGHT = value;
            else if (variable === 'SUN_DIAMETER') SUN_DIAMETER = value;
            else if (variable === 'SUN_THICKNESS') SUN_THICKNESS = value;
            else if (variable === 'MOON_DIAMETER') MOON_DIAMETER = value;
            else if (variable === 'MOON_ANGLE') MOON_ANGLE = value;
            else if (variable === 'MOON_HEIGHT') MOON_HEIGHT = value;
            else if (variable === 'FILLET_RADIUS') FILLET_RADIUS = value;

            if (isInitialized) {
                if (updateType === 'ring') {
                    createAndDisplayJewelry();
                } else if (updateType === 'moon') {
                    rebuildMoonMesh();
                } else if (updateType === 'both') {
                    createAndDisplayJewelry();
                } else if (updateType === 'transform') {
                    updateMoonPosition();
                }
            }
        });
    });

    // Animation degrees slider
    const animDegreesSlider = document.getElementById('animationDegrees');
    if (animDegreesSlider) {
        animDegreesSlider.addEventListener('input', (e) => {
            animationDegrees = parseFloat(e.target.value);
            document.getElementById('animationDegrees-value').textContent = animationDegrees.toFixed(0) + '°';
        });
    }

    // Start animation button
    const startAnimBtn = document.getElementById('startAnimation');
    if (startAnimBtn) {
        startAnimBtn.addEventListener('click', startAnimation);
    }

    // Color grading controls
    const saturationSlider = document.getElementById('saturation');
    if (saturationSlider) {
        saturationSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('saturation-value').textContent = value.toFixed(2);
            if (colorGradingPass && colorGradingPass.uniforms) {
                colorGradingPass.uniforms['saturation'].value = value;
            }
        });
    }

    const contrastSlider = document.getElementById('contrast');
    if (contrastSlider) {
        contrastSlider.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value);
            document.getElementById('contrast-value').textContent = value.toFixed(2);
            if (colorGradingPass && colorGradingPass.uniforms) {
                colorGradingPass.uniforms['contrast'].value = value;
            }
        });
    }
}

// Main initialization
async function initializeApp() {
    console.log('Starting initialization...');

    await initializeReplicad();
    initThreeJS();
    setupSliders();
    setupPresetButtons();

    if (isInitialized) {
        await createAndDisplayJewelry();
    }

    console.log('Initialization complete');
}

// Expose to window for HTML button access
window.startAnimation = startAnimation;

initializeApp().catch(error => {
    console.error('Failed to initialize application:', error);
});
