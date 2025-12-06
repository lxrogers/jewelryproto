/**
 * Coin Mesh Generator - Type Definitions
 */

/** A 2D point on the outline */
export interface OutlinePoint {
  /** x, y coordinates in the XY plane */
  position: [number, number];
  /** Outward-pointing unit normal vector */
  normal: [number, number];
}

/** Function that returns outline points and normals for a given parameter t [0, 1] */
export type OutlineFunction = (t: number) => OutlinePoint;

/** UV mapping mode for the mesh */
export type UVMode = 'planar' | 'cylindrical';

/** Y-axis deformation parameters using noise */
export interface DeformationParams {
  /** Enable Y deformation */
  enabled: boolean;
  /** Amplitude of deformation in Y direction */
  amplitude: number;
  /** Frequency/scale of noise in X direction */
  frequencyX: number;
  /** Frequency/scale of noise in Z direction */
  frequencyZ: number;
  /** Phase offset in X direction */
  phaseX: number;
  /** Phase offset in Z direction */
  phaseZ: number;
  /** Number of octaves for fractal noise (1 = simple, higher = more detail) */
  octaves: number;
  /** How much each octave contributes (0.5 = typical) */
  persistence: number;
}

/** Parameters for generating a coin mesh */
export interface CoinMeshParams {
  /** Function that returns outline points and normals */
  outline: OutlineFunction;

  /** Number of samples around the outline perimeter (e.g., 64-256) */
  outlineSamples: number;

  /** Number of segments in the rounded edge profile / semicircle (e.g., 8-16) */
  profileSegments: number;

  /** Total thickness of the coin (z-extent) */
  thickness: number;

  /** Radius of the rounded edge (fillet radius) */
  edgeRadius: number;

  /** UV mapping mode (default: 'planar') */
  uvMode?: UVMode;

  /** Number of radial segments for face triangulation (for displacement mapping) */
  faceRadialSegments?: number;

  /** Y-axis deformation parameters */
  deformation?: DeformationParams;
}

/** Quality preset levels */
export interface QualityPreset {
  outlineSamples: number;
  profileSegments: number;
  faceRadialSegments: number;
}

/** Available quality presets */
export const QUALITY_PRESETS: Record<'low' | 'medium' | 'high', QualityPreset> = {
  low: { outlineSamples: 32, profileSegments: 8, faceRadialSegments: 8 },
  medium: { outlineSamples: 64, profileSegments: 12, faceRadialSegments: 16 },
  high: { outlineSamples: 128, profileSegments: 16, faceRadialSegments: 32 },
};
