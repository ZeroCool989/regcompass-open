'use client';

import dynamic from 'next/dynamic';

const Scene = dynamic(() => import('./Compass3DScene'), {
  ssr: false,
  loading: () => <div className="w-full h-full" aria-hidden="true" />,
});

export default function Compass3D({ className }: { className?: string }) {
  return (
    <div className={className} aria-label="3D-Kompass">
      <Scene />
    </div>
  );
}
