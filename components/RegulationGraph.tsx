'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

export type GraphNode = {
  id: string;
  label: string;
  jurisdiction: string;
  bindingLevel: string;
  requirementCount: number;
};

export type GraphEdge = {
  source: string;
  target: string;
  topics: string[];
  weight: number;
};

type SimNode = GraphNode & {
  x: number;
  y: number;
  radius: number;
  pinned: boolean;
  // Orbit params (always active — no mode switching)
  orbitRadius: number;       // current orbit radius (0 = at center)
  targetRadius: number;      // where orbit radius is heading
  orbitPhase: number;        // angular offset
  orbitSpeed: number;        // rad/s, positive = CCW, negative = CW
};

const BINDING_COLORS: Record<string, string> = {
  mandatory: '#F44336',
  supervisory_expectation: '#FFC107',
  best_practice: '#00BFFF',
};

const GLOW_COLORS: Record<string, string> = {
  mandatory: 'rgba(244, 67, 54, 0.6)',
  supervisory_expectation: 'rgba(255, 193, 7, 0.6)',
  best_practice: 'rgba(0, 191, 255, 0.6)',
};

const RAMP_MS = 4000;
const SWAP_EVERY = 12000;
const SWAP_JITTER = 3000;
// How fast orbit radius transitions (0→1 = instant, lower = smoother)
const RADIUS_LERP = 0.006;

export function RegulationGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<SimNode[]>([]);
  const animRef = useRef<number>(0);
  const hoveredRef = useRef<string | null>(null);
  const dragRef = useRef<{ nodeId: string | null; offsetX: number; offsetY: number }>({
    nodeId: null, offsetX: 0, offsetY: 0,
  });
  const [tooltip, setTooltip] = useState<{ x: number; y: number; node: GraphNode } | null>(null);

  const maxReqCount = Math.max(...nodes.map((n) => n.requirementCount), 1);
  const getRadius = useCallback(
    (count: number) => 14 + (count / maxReqCount) * 22,
    [maxReqCount]
  );

  const adjacency = useRef(new Map<string, Set<string>>());
  useEffect(() => {
    const adj = new Map<string, Set<string>>();
    for (const n of nodes) adj.set(n.id, new Set());
    for (const e of edges) {
      adj.get(e.source)?.add(e.target);
      adj.get(e.target)?.add(e.source);
    }
    adjacency.current = adj;
  }, [nodes, edges]);

  // Initialize
  useEffect(() => {
    const w = containerRef.current?.clientWidth ?? 800;
    const h = window.innerWidth < 768 ? 400 : 600;
    const cx = w / 2;
    const cy = h / 2;
    const spread = Math.min(w, h) * 0.46;

    // Biggest node starts at center (orbitRadius = 0)
    let centerIdx = 0;
    let maxReq = 0;
    nodes.forEach((n, i) => { if (n.requirementCount > maxReq) { maxReq = n.requirementCount; centerIdx = i; } });

    let orbitI = 0;
    simRef.current = nodes.map((n, i) => {
      const r = getRadius(n.requirementCount);
      if (i === centerIdx) {
        return {
          ...n, x: cx, y: cy, radius: r, pinned: false,
          orbitRadius: 0, targetRadius: 0,
          orbitPhase: Math.random() * Math.PI * 2,
          orbitSpeed: 0.015,
        };
      }
      const angle = orbitI * 2.399; // golden angle
      const ringR = spread * (0.5 + (orbitI / Math.max(nodes.length - 1, 1)) * 0.5);
      const dir = orbitI % 3 === 0 ? -1 : 1;
      const speed = dir * (0.012 + (orbitI * 0.0037) % 0.013);
      orbitI++;
      return {
        ...n,
        x: cx + Math.cos(angle) * ringR,
        y: cy + Math.sin(angle) * ringR,
        radius: r, pinned: false,
        orbitRadius: ringR, targetRadius: ringR,
        orbitPhase: angle,
        orbitSpeed: speed,
      };
    });
  }, [nodes, getRadius]);

  // Animation
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = container.clientWidth;
    let h = window.innerWidth < 768 ? 400 : 600;
    const dpr = window.devicePixelRatio || 1;

    function resize() {
      w = container!.clientWidth;
      h = window.innerWidth < 768 ? 400 : 600;
      canvas!.width = w * dpr;
      canvas!.height = h * dpr;
      canvas!.style.width = w + 'px';
      canvas!.style.height = h + 'px';
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);

    const t0 = performance.now();
    let centerNodeIdx = simRef.current.findIndex(n => n.orbitRadius === 0);
    let nextSwapAt = t0 + SWAP_EVERY;

    function simulate() {
      const sim = simRef.current;
      if (!sim.length) return;
      const now = performance.now();
      const elapsed = now - t0;
      const t = elapsed / 1000;
      const ramp = Math.min(1, elapsed / RAMP_MS);
      const speedMul = ramp * ramp;
      const cx = w / 2;
      const cy = h / 2;

      // Auto-swap: set the incoming node's targetRadius to 0, outgoing to a real radius
      if (now >= nextSwapAt) {
        const pool = sim.filter((n, i) => i !== centerNodeIdx && !n.pinned && n.targetRadius > 0);
        if (pool.length > 0) {
          const incoming = pool[Math.floor(Math.random() * pool.length)];
          const incomingIdx = sim.indexOf(incoming);
          const outgoing = sim[centerNodeIdx];

          // Outgoing: give it the incoming's target radius (it spirals out)
          if (outgoing && outgoing.targetRadius === 0) {
            outgoing.targetRadius = incoming.targetRadius;
          }

          // Incoming: spiral in to center
          incoming.targetRadius = 0;

          centerNodeIdx = incomingIdx;
        }
        nextSwapAt = now + SWAP_EVERY + (Math.random() * 2 - 1) * SWAP_JITTER;
      }

      for (const node of sim) {
        if (node.pinned) continue;

        // Smoothly lerp orbit radius toward target — this is the whole trick
        // No snapping, no tween mode, just a continuous smooth transition
        node.orbitRadius += (node.targetRadius - node.orbitRadius) * RADIUS_LERP;

        // Compute position from orbit
        const angle = node.orbitPhase + node.orbitSpeed * speedMul * t;
        node.x = cx + node.orbitRadius * Math.cos(angle);
        node.y = cy + node.orbitRadius * Math.sin(angle);
      }
    }

    function isDarkMode() {
      return document.documentElement.classList.contains('dark');
    }

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);
      const sim = simRef.current;
      const hovered = hoveredRef.current;
      const connectedToHovered = hovered ? adjacency.current.get(hovered) : null;
      const dark = isDarkMode();

      const edgeDefault = dark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)';
      const edgeHighlight = dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)';
      const edgeDimmed = dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)';
      const labelColor = dark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.85)';
      const labelDimmed = dark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)';
      const borderDefault = dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
      const borderHovered = dark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)';
      const glossHi = dark ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.45)';

      for (const edge of edges) {
        const a = sim.find((n) => n.id === edge.source);
        const b = sim.find((n) => n.id === edge.target);
        if (!a || !b) continue;
        const isHighlighted = hovered && (edge.source === hovered || edge.target === hovered);
        const isDimmed = hovered && !isHighlighted;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = isDimmed ? edgeDimmed : isHighlighted ? edgeHighlight : edgeDefault;
        ctx.lineWidth = isHighlighted ? 1 + edge.weight * 0.6 : 0.4 + edge.weight * 0.3;
        ctx.stroke();
      }

      for (const node of sim) {
        const isHovered = node.id === hovered;
        const isConnected = connectedToHovered?.has(node.id);
        const isDimmed = hovered && !isHovered && !isConnected;
        const color = BINDING_COLORS[node.bindingLevel] || '#00BFFF';
        const glow = GLOW_COLORS[node.bindingLevel] || 'rgba(0,191,255,0.6)';

        ctx.save();
        ctx.globalAlpha = isDimmed ? 0.2 : 1;

        ctx.beginPath();
        ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
        ctx.shadowColor = glow;
        ctx.shadowBlur = isHovered ? 25 : 10;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.shadowBlur = 0;

        const grad = ctx.createRadialGradient(
          node.x - node.radius * 0.3, node.y - node.radius * 0.3, 0,
          node.x, node.y, node.radius
        );
        grad.addColorStop(0, glossHi);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.strokeStyle = isHovered ? borderHovered : borderDefault;
        ctx.lineWidth = isHovered ? 2 : 0.8;
        ctx.stroke();

        ctx.fillStyle = isDimmed ? labelDimmed : labelColor;
        ctx.font = `${isHovered ? 'bold ' : ''}11px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(node.label, node.x, node.y + node.radius + 5);

        ctx.restore();
      }
    }

    function loop() {
      simulate();
      draw();
      animRef.current = requestAnimationFrame(loop);
    }
    animRef.current = requestAnimationFrame(loop);

    // --- Interaction ---
    function getCanvasPos(clientX: number, clientY: number) {
      const rect = canvas!.getBoundingClientRect();
      return { x: clientX - rect.left, y: clientY - rect.top };
    }

    function findNode(px: number, py: number): SimNode | null {
      for (let i = simRef.current.length - 1; i >= 0; i--) {
        const n = simRef.current[i];
        const dx = px - n.x;
        const dy = py - n.y;
        if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) return n;
      }
      return null;
    }

    function handleMouseMove(e: MouseEvent) {
      const pos = getCanvasPos(e.clientX, e.clientY);
      if (dragRef.current.nodeId) {
        const node = simRef.current.find((n) => n.id === dragRef.current.nodeId);
        if (node) { node.x = pos.x - dragRef.current.offsetX; node.y = pos.y - dragRef.current.offsetY; }
        return;
      }
      const hit = findNode(pos.x, pos.y);
      hoveredRef.current = hit?.id ?? null;
      canvas!.style.cursor = hit ? 'pointer' : 'default';
      if (hit) {
        const rect = container!.getBoundingClientRect();
        setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, node: hit });
      } else {
        setTooltip(null);
      }
    }

    function handleMouseDown(e: MouseEvent) {
      const pos = getCanvasPos(e.clientX, e.clientY);
      const hit = findNode(pos.x, pos.y);
      if (hit) {
        dragRef.current = { nodeId: hit.id, offsetX: pos.x - hit.x, offsetY: pos.y - hit.y };
        hit.pinned = true;
        e.preventDefault();
      }
    }

    function handleMouseUp() {
      if (dragRef.current.nodeId) {
        const node = simRef.current.find((n) => n.id === dragRef.current.nodeId);
        if (node) {
          node.pinned = false;
          const now = performance.now();
          const t = (now - t0) / 1000;
          const ramp = Math.min(1, (now - t0) / RAMP_MS);
          const speedMul = ramp * ramp;
          const dx = node.x - w / 2;
          const dy = node.y - h / 2;
          const r = Math.hypot(dx, dy);
          node.orbitRadius = r;
          node.targetRadius = r;
          node.orbitPhase = Math.atan2(dy, dx) - node.orbitSpeed * speedMul * t;
          const idx = simRef.current.indexOf(node);
          if (idx === centerNodeIdx) centerNodeIdx = -1;
        }
        dragRef.current = { nodeId: null, offsetX: 0, offsetY: 0 };
      }
    }

    function handleClick(e: MouseEvent) {
      if (dragRef.current.nodeId) return;
      const pos = getCanvasPos(e.clientX, e.clientY);
      const hit = findNode(pos.x, pos.y);
      if (hit) window.location.href = `/kb?regulation=${hit.id}`;
    }

    function handleMouseLeave() {
      hoveredRef.current = null;
      setTooltip(null);
      canvas!.style.cursor = 'default';
    }

    function handleTouchStart(e: TouchEvent) {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const pos = getCanvasPos(touch.clientX, touch.clientY);
      const hit = findNode(pos.x, pos.y);
      if (hit) {
        dragRef.current = { nodeId: hit.id, offsetX: pos.x - hit.x, offsetY: pos.y - hit.y };
        hit.pinned = true;
        hoveredRef.current = hit.id;
        e.preventDefault();
      }
    }

    function handleTouchMove(e: TouchEvent) {
      if (!dragRef.current.nodeId || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const pos = getCanvasPos(touch.clientX, touch.clientY);
      const node = simRef.current.find((n) => n.id === dragRef.current.nodeId);
      if (node) { node.x = pos.x - dragRef.current.offsetX; node.y = pos.y - dragRef.current.offsetY; }
      e.preventDefault();
    }

    function handleTouchEnd(e: TouchEvent) {
      if (dragRef.current.nodeId) {
        const node = simRef.current.find((n) => n.id === dragRef.current.nodeId);
        if (node) node.pinned = false;
        if (e.changedTouches.length === 1) {
          const touch = e.changedTouches[0];
          const pos = getCanvasPos(touch.clientX, touch.clientY);
          const hit = findNode(pos.x, pos.y);
          if (hit && hit.id === dragRef.current.nodeId) window.location.href = `/kb?regulation=${hit.id}`;
        }
        dragRef.current = { nodeId: null, offsetX: 0, offsetY: 0 };
      }
      hoveredRef.current = null;
      setTooltip(null);
    }

    canvas.addEventListener('mousemove', handleMouseMove);
    canvas.addEventListener('mousedown', handleMouseDown);
    canvas.addEventListener('mouseup', handleMouseUp);
    canvas.addEventListener('click', handleClick);
    canvas.addEventListener('mouseleave', handleMouseLeave);
    canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
    canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
    canvas.addEventListener('touchend', handleTouchEnd);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener('resize', resize);
      canvas.removeEventListener('mousemove', handleMouseMove);
      canvas.removeEventListener('mousedown', handleMouseDown);
      canvas.removeEventListener('mouseup', handleMouseUp);
      canvas.removeEventListener('click', handleClick);
      canvas.removeEventListener('mouseleave', handleMouseLeave);
      canvas.removeEventListener('touchstart', handleTouchStart);
      canvas.removeEventListener('touchmove', handleTouchMove);
      canvas.removeEventListener('touchend', handleTouchEnd);
    };
  }, [nodes, edges, getRadius]);

  const BINDING_LABELS: Record<string, string> = {
    mandatory: 'Mandatory',
    supervisory_expectation: 'Supervisory',
    best_practice: 'Best Practice',
  };

  return (
    <div ref={containerRef} className="relative w-full" style={{ height: 'auto' }}>
      <canvas ref={canvasRef} className="w-full h-[400px] md:h-[600px]" />
      {tooltip && (
        <div
          className="absolute pointer-events-none z-10 px-3 py-2 rounded-lg bg-surface border border-border-brand shadow-xl text-xs"
          style={{
            left: Math.min(tooltip.x + 12, (containerRef.current?.clientWidth ?? 400) - 180),
            top: tooltip.y - 60,
          }}
        >
          <p className="font-bold text-foreground mb-1">{tooltip.node.label}</p>
          <p className="text-text-secondary">Jurisdiction: {tooltip.node.jurisdiction}</p>
          <p className="text-text-secondary">Requirements: {tooltip.node.requirementCount}</p>
          <p className="text-text-secondary">
            Binding:{' '}
            <span style={{ color: BINDING_COLORS[tooltip.node.bindingLevel] }}>
              {BINDING_LABELS[tooltip.node.bindingLevel] || tooltip.node.bindingLevel}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
