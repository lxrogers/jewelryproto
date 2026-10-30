/**
 * Coin Mesh Generator - Outline Functions
 * Provides various parametric outline generators
 */

import { OutlineFunction, OutlinePoint } from './types';

/**
 * Creates a circular outline function
 * @param radius - Radius of the circle
 */
export function createCircleOutline(radius: number): OutlineFunction {
  return (t: number): OutlinePoint => {
    const angle = t * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      position: [cos * radius, sin * radius],
      normal: [cos, sin],
    };
  };
}

/**
 * Creates a superellipse (squircle-like) outline function
 * @param a - Semi-major axis (x direction)
 * @param b - Semi-minor axis (y direction)
 * @param n - Exponent controlling squareness (2 = ellipse, higher = more square)
 */
export function createSuperellipseOutline(a: number, b: number, n: number): OutlineFunction {
  return (t: number): OutlinePoint => {
    const angle = t * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    // Superellipse parametric form: |x/a|^n + |y/b|^n = 1
    // Using signed power to maintain sign
    const signedPow = (base: number, exp: number): number => {
      return Math.sign(base) * Math.pow(Math.abs(base), exp);
    };

    const exp = 2 / n;
    const x = a * signedPow(cos, exp);
    const y = b * signedPow(sin, exp);

    // Compute tangent by differentiating
    // dx/dt = -a * (2/n) * |cos|^(2/n - 1) * sin
    // dy/dt = b * (2/n) * |sin|^(2/n - 1) * cos
    const eps = 0.0001;
    const t1 = t + eps;
    const angle1 = t1 * Math.PI * 2;
    const x1 = a * signedPow(Math.cos(angle1), exp);
    const y1 = b * signedPow(Math.sin(angle1), exp);

    const dx = x1 - x;
    const dy = y1 - y;
    const tangentLen = Math.sqrt(dx * dx + dy * dy);

    // Normal is perpendicular to tangent, pointing outward
    // Rotate tangent 90 degrees clockwise: (dx, dy) -> (dy, -dx)
    // But we need outward, so: (-dy, dx) normalized
    let nx = dy / tangentLen;
    let ny = -dx / tangentLen;

    // Ensure normal points outward (away from center)
    const dot = nx * x + ny * y;
    if (dot < 0) {
      nx = -nx;
      ny = -ny;
    }

    return {
      position: [x, y],
      normal: [nx, ny],
    };
  };
}

/**
 * Simple seeded random number generator
 */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Creates a blob-shaped outline with organic noise
 * @param baseRadius - Base radius of the blob
 * @param noiseFreq - Frequency of the noise (number of bumps)
 * @param noiseAmp - Amplitude of the noise as fraction of baseRadius
 * @param seed - Random seed for reproducibility
 */
export function createBlobOutline(
  baseRadius: number,
  noiseFreq: number,
  noiseAmp: number,
  seed: number = 42
): OutlineFunction {
  // Generate random amplitudes and phases for each frequency component
  const rng = seededRandom(seed);
  const components: { freq: number; amp: number; phase: number }[] = [];

  // Add multiple harmonics for organic look
  const numHarmonics = 4;
  for (let i = 0; i < numHarmonics; i++) {
    const f = noiseFreq * (i + 1);
    const a = noiseAmp * Math.pow(0.5, i); // Decreasing amplitude for higher harmonics
    components.push({
      freq: f,
      amp: a,
      phase: rng() * Math.PI * 2,
    });
  }

  return (t: number): OutlinePoint => {
    const angle = t * Math.PI * 2;

    // Sum all noise components
    let radiusOffset = 0;
    let dRadiusDt = 0; // Derivative of radius with respect to t
    for (const { freq, amp, phase } of components) {
      radiusOffset += amp * Math.sin(freq * angle + phase);
      dRadiusDt += amp * freq * Math.PI * 2 * Math.cos(freq * angle + phase);
    }

    const r = baseRadius * (1 + radiusOffset);
    const drDt = baseRadius * dRadiusDt;

    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const x = r * cos;
    const y = r * sin;

    // Tangent: d/dt [r(t) * cos(2*pi*t), r(t) * sin(2*pi*t)]
    // = [dr/dt * cos - r * 2*pi * sin, dr/dt * sin + r * 2*pi * cos]
    const dxDt = drDt * cos - r * Math.PI * 2 * sin;
    const dyDt = drDt * sin + r * Math.PI * 2 * cos;

    const tangentLen = Math.sqrt(dxDt * dxDt + dyDt * dyDt);

    // Normal perpendicular to tangent, pointing outward
    let nx = dyDt / tangentLen;
    let ny = -dxDt / tangentLen;

    // Ensure outward
    const dot = nx * x + ny * y;
    if (dot < 0) {
      nx = -nx;
      ny = -ny;
    }

    return {
      position: [x, y],
      normal: [nx, ny],
    };
  };
}

/**
 * Creates an outline function from a set of discrete points
 * Uses Catmull-Rom spline interpolation for smooth curves
 * @param points - Array of [x, y] points defining the outline (should be roughly evenly spaced)
 * @param closed - Whether the outline is closed (default: true)
 */
export function createOutlineFromPoints(
  points: [number, number][],
  closed: boolean = true
): OutlineFunction {
  const n = points.length;
  if (n < 3) {
    throw new Error('At least 3 points required for outline');
  }

  // Catmull-Rom interpolation helper
  const catmullRom = (
    p0: [number, number],
    p1: [number, number],
    p2: [number, number],
    p3: [number, number],
    t: number
  ): [number, number] => {
    const t2 = t * t;
    const t3 = t2 * t;

    const x =
      0.5 *
      (2 * p1[0] +
        (-p0[0] + p2[0]) * t +
        (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
        (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);

    const y =
      0.5 *
      (2 * p1[1] +
        (-p0[1] + p2[1]) * t +
        (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
        (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);

    return [x, y];
  };

  // Get point with wrapping for closed curves
  const getPoint = (i: number): [number, number] => {
    if (closed) {
      return points[((i % n) + n) % n];
    }
    return points[Math.max(0, Math.min(n - 1, i))];
  };

  return (t: number): OutlinePoint => {
    // Map t [0, 1] to segment index and local t
    const totalT = t * n;
    const segmentIndex = Math.floor(totalT);
    const localT = totalT - segmentIndex;

    // Get the 4 control points for Catmull-Rom
    const p0 = getPoint(segmentIndex - 1);
    const p1 = getPoint(segmentIndex);
    const p2 = getPoint(segmentIndex + 1);
    const p3 = getPoint(segmentIndex + 2);

    const pos = catmullRom(p0, p1, p2, p3, localT);

    // Compute tangent numerically
    const eps = 0.0001;
    const pos2 = catmullRom(p0, p1, p2, p3, Math.min(1, localT + eps));
    const dx = pos2[0] - pos[0];
    const dy = pos2[1] - pos[1];
    const tangentLen = Math.sqrt(dx * dx + dy * dy);

    // Normal perpendicular to tangent
    let nx = dy / tangentLen;
    let ny = -dx / tangentLen;

    // Ensure outward (assuming points are ordered counter-clockwise)
    const dot = nx * pos[0] + ny * pos[1];
    if (dot < 0) {
      nx = -nx;
      ny = -ny;
    }

    return {
      position: pos,
      normal: [nx, ny],
    };
  };
}

/**
 * Creates an ellipse outline
 * @param a - Semi-major axis (x direction)
 * @param b - Semi-minor axis (y direction)
 */
export function createEllipseOutline(a: number, b: number): OutlineFunction {
  return (t: number): OutlinePoint => {
    const angle = t * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const x = a * cos;
    const y = b * sin;

    // Tangent: (-a*sin, b*cos)
    const tx = -a * sin;
    const ty = b * cos;
    const tangentLen = Math.sqrt(tx * tx + ty * ty);

    // Normal: perpendicular to tangent, pointing outward
    // Rotate (tx, ty) by 90 degrees: (ty, -tx)
    const nx = ty / tangentLen;
    const ny = -tx / tangentLen;

    return {
      position: [x, y],
      normal: [nx, ny],
    };
  };
}

/**
 * Creates a rounded rectangle outline
 * @param width - Total width
 * @param height - Total height
 * @param cornerRadius - Radius of the rounded corners
 */
export function createRoundedRectOutline(
  width: number,
  height: number,
  cornerRadius: number
): OutlineFunction {
  const hw = width / 2;
  const hh = height / 2;
  const r = Math.min(cornerRadius, Math.min(hw, hh));

  // Total perimeter for proper parameterization
  const straightWidth = width - 2 * r;
  const straightHeight = height - 2 * r;
  const cornerArc = (Math.PI / 2) * r;
  const totalPerimeter = 2 * straightWidth + 2 * straightHeight + 4 * cornerArc;

  return (t: number): OutlinePoint => {
    // Adjust t to start from right side, going counter-clockwise
    let dist = t * totalPerimeter;

    // Segment order: right straight, top-right corner, top straight, top-left corner,
    // left straight, bottom-left corner, bottom straight, bottom-right corner

    // Right straight (going up)
    const seg1 = straightHeight;
    if (dist < seg1) {
      const y = -hh + r + dist;
      return {
        position: [hw, y],
        normal: [1, 0],
      };
    }
    dist -= seg1;

    // Top-right corner
    const seg2 = cornerArc;
    if (dist < seg2) {
      const angle = dist / r; // 0 to PI/2
      const cx = hw - r;
      const cy = hh - r;
      return {
        position: [cx + r * Math.cos(angle), cy + r * Math.sin(angle)],
        normal: [Math.cos(angle), Math.sin(angle)],
      };
    }
    dist -= seg2;

    // Top straight (going left)
    const seg3 = straightWidth;
    if (dist < seg3) {
      const x = hw - r - dist;
      return {
        position: [x, hh],
        normal: [0, 1],
      };
    }
    dist -= seg3;

    // Top-left corner
    const seg4 = cornerArc;
    if (dist < seg4) {
      const angle = Math.PI / 2 + dist / r;
      const cx = -hw + r;
      const cy = hh - r;
      return {
        position: [cx + r * Math.cos(angle), cy + r * Math.sin(angle)],
        normal: [Math.cos(angle), Math.sin(angle)],
      };
    }
    dist -= seg4;

    // Left straight (going down)
    const seg5 = straightHeight;
    if (dist < seg5) {
      const y = hh - r - dist;
      return {
        position: [-hw, y],
        normal: [-1, 0],
      };
    }
    dist -= seg5;

    // Bottom-left corner
    const seg6 = cornerArc;
    if (dist < seg6) {
      const angle = Math.PI + dist / r;
      const cx = -hw + r;
      const cy = -hh + r;
      return {
        position: [cx + r * Math.cos(angle), cy + r * Math.sin(angle)],
        normal: [Math.cos(angle), Math.sin(angle)],
      };
    }
    dist -= seg6;

    // Bottom straight (going right)
    const seg7 = straightWidth;
    if (dist < seg7) {
      const x = -hw + r + dist;
      return {
        position: [x, -hh],
        normal: [0, -1],
      };
    }
    dist -= seg7;

    // Bottom-right corner
    const angle = (3 * Math.PI) / 2 + dist / r;
    const cx = hw - r;
    const cy = -hh + r;
    return {
      position: [cx + r * Math.cos(angle), cy + r * Math.sin(angle)],
      normal: [Math.cos(angle), Math.sin(angle)],
    };
  };
}
