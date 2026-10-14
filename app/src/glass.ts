import * as THREE from 'three';

// Real windows for a car body whose material has the pipeline's metallicRoughness map (glass texels
// have roughness < 0.2; super-tinted glass - hints model.rebake.tinted - sits at ~0.13, clear at ~0.06).
// The body is drawn twice from one geometry:
//   body pass  - double-sided, glass texels cut out, inside faces dark (you look into a cabin)
//   glass pass - only the glass texels: a tinted, glossy, see-through pane, drawn after the body
// Works on top of any onBeforeCompile the material already has (the reveal's carMaterial).

const INTERIOR = 'vec3(0.022, 0.022, 0.026)';
const TINT = 'vec3(0.03, 0.035, 0.045)';
const DARK_TINT = 'vec3(0.006, 0.007, 0.009)'; // super tinted: near black, the cabin a shadow behind it
const DARK_OPACITY = 0.9;

function patch(m: THREE.MeshStandardMaterial, mode: 'body' | 'glass', opacity: number) {
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey.bind(m);
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace(
      '#include <alphamap_fragment>',
      `float glassR = texture2D(roughnessMap, vRoughnessMapUv).g;
      float glassMask = step(glassR, 0.2);
      ${mode === 'body'
        ? `if (glassMask > 0.5) discard;
           if (!gl_FrontFacing) diffuseColor.rgb = ${INTERIOR};`
        : `if (glassMask < 0.5) discard;
           float dark = step(0.095, glassR);
           diffuseColor.rgb = mix(${TINT}, ${DARK_TINT}, dark);
           diffuseColor.a *= mix(${opacity.toFixed(3)}, ${DARK_OPACITY.toFixed(3)}, dark);`}
      #include <alphamap_fragment>`,
    );
  };
  m.customProgramCacheKey = () => `${prevKey()}|glass-${mode}`;
}

/** Split a body mesh into body + glass passes. Returns the glass mesh (already added next to the body),
 *  or null if the material has no glass map. `makeMaterial` builds a fresh material like the body's
 *  (cloning would drop its shader patch). */
export function splitGlass(
  body: THREE.Mesh,
  makeMaterial: () => THREE.MeshStandardMaterial = () => (body.material as THREE.MeshStandardMaterial).clone(),
  opacity = 0.38,
): THREE.Mesh | null {
  const bodyMat = body.material as THREE.MeshStandardMaterial;
  if (!bodyMat.roughnessMap) return null;
  const glassMat = makeMaterial();
  bodyMat.side = THREE.DoubleSide;
  patch(bodyMat, 'body', opacity);
  glassMat.transparent = true;
  glassMat.depthWrite = false;
  glassMat.side = THREE.FrontSide;
  if ('clearcoat' in glassMat) (glassMat as THREE.MeshPhysicalMaterial).clearcoat = 1;
  patch(glassMat, 'glass', opacity);
  const glass = new THREE.Mesh(body.geometry, glassMat);
  glass.name = `${body.name}_glass`;
  glass.renderOrder = body.renderOrder + 1;
  body.add(glass); // child with identity transform: follows the body everywhere
  return glass;
}
