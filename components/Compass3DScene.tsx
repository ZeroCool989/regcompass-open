'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text, useGLTF } from '@react-three/drei';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Box3, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';

const MODEL_URL = '/models/compass/bussola.glb';
const TARGET_SIZE = 1.8;

const BODY_MATERIAL = 'Material.001';
const NEEDLE_MATERIAL = 'Material.003';

function useIsDark() {
  const [isDark, setIsDark] = useState(true);
  useEffect(() => {
    const html = document.documentElement;
    const sync = () => setIsDark(html.classList.contains('dark'));
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(html, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return isDark;
}

function CompassMesh({ isDark }: { isDark: boolean }) {
  const spinRef = useRef<Group>(null);
  const { scene } = useGLTF(MODEL_URL);

  const { fitted, faceTilt } = useMemo(() => {
    const obj = scene.clone(true);
    const box = new Box3().setFromObject(obj);
    const size = box.getSize(new Vector3());
    const center = box.getCenter(new Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const s = TARGET_SIZE / maxDim;
    obj.scale.setScalar(s);
    obj.position.set(-center.x * s, -center.y * s, -center.z * s);

    // Bring the thinnest axis (= compass-face normal) to +Z so the dial faces the camera
    const dims = { x: size.x, y: size.y, z: size.z };
    const thin = (Object.keys(dims) as Array<'x' | 'y' | 'z'>).reduce((m, a) =>
      dims[a] < dims[m] ? a : m, 'x' as 'x' | 'y' | 'z');
    let tilt: [number, number, number] = [0, 0, 0];
    if (thin === 'y') tilt = [Math.PI / 2, 0, 0];
    else if (thin === 'x') tilt = [0, -Math.PI / 2, 0];

    return { fitted: obj, faceTilt: tilt };
  }, [scene]);

  useEffect(() => {
    fitted.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const src = mesh.material as MeshStandardMaterial;
      const mat = src.clone();
      const isNeedle = src.name === NEEDLE_MATERIAL;
      const wantWhite = isDark ? !isNeedle : isNeedle;
      mat.color.set(wantWhite ? '#f5f5f5' : '#0a0a0a');
      mat.metalness = 0.15;
      mat.roughness = 0.55;
      mesh.material = mat;
    });
  }, [fitted, isDark]);

  useFrame((state) => {
    if (spinRef.current) {
      spinRef.current.rotation.y = Math.sin(state.clock.elapsedTime * 0.7) * 1.0;
    }
  });

  const labelColor = isDark ? '#0a0a0a' : '#f5f5f5';

  return (
    <group rotation={faceTilt}>
      <group ref={spinRef}>
        <primitive object={fitted} />
      </group>
      <CompassLabels color={labelColor} />
    </group>
  );
}

function CompassLabels({ color }: { color: string }) {
  // Counter-rotate to undo the parent's face-tilt so this group's local frame
  // matches world frame. Then place labels at cardinal positions on the face.
  const r = 0.62;
  const z = 0.08;
  const size = 0.18;
  const props = { fontSize: size, color, anchorX: 'center' as const, anchorY: 'middle' as const };
  return (
    <group rotation={[-Math.PI / 2, 0, 0]}>
      <Text position={[0, r, z]} {...props}>N</Text>
      <Text position={[r, 0, z]} {...props}>E</Text>
      <Text position={[0, -r, z]} {...props}>S</Text>
      <Text position={[-r, 0, z]} {...props}>W</Text>
    </group>
  );
}

useGLTF.preload(MODEL_URL);

export default function Compass3DScene() {
  const isDark = useIsDark();
  return (
    <Canvas
      camera={{ position: [0, 0, 3.8], fov: 35 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
    >
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 5, 3]} intensity={1.1} />
      <directionalLight position={[-3, -2, -4]} intensity={0.3} color="#7dd3fc" />
      <Suspense fallback={null}>
        <CompassMesh isDark={isDark} />
      </Suspense>
      <OrbitControls
        enableDamping
        dampingFactor={0.08}
        enablePan={false}
        enableZoom={false}
        rotateSpeed={0.8}
      />
    </Canvas>
  );
}
