'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { GLOSSARY, type GlossaryEntry } from '@/lib/glossary';

export function GlossaryTooltip({
  term,
  children,
}: {
  term: string;
  children: ReactNode;
}) {
  const entry = GLOSSARY[term];
  const [open, setOpen] = useState(false);
  const [above, setAbove] = useState(true);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const show = useCallback(() => {
    if (wrapperRef.current) {
      const rect = wrapperRef.current.getBoundingClientRect();
      setAbove(rect.top > 200);
    }
    setOpen(true);
  }, []);

  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  if (!entry) return <>{children}</>;

  return (
    <span
      ref={wrapperRef}
      className="relative inline"
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <span
        className="border-b border-dashed border-text-secondary/50 cursor-help hover:border-brand-primary hover:text-brand-primary transition-colors"
        onClick={() => setOpen(!open)}
        role="button"
        tabIndex={0}
        aria-describedby={open ? `glossary-${term}` : undefined}
      >
        {children}
      </span>
      {open && (
        <div
          ref={tooltipRef}
          id={`glossary-${term}`}
          role="tooltip"
          className={`absolute z-50 w-72 px-3.5 py-3 rounded-lg border border-border-brand bg-surface shadow-lg shadow-black/30 text-sm ${
            above ? 'bottom-full mb-2' : 'top-full mt-2'
          } left-1/2 -translate-x-1/2`}
        >
          <div className={`absolute left-1/2 -translate-x-1/2 w-2.5 h-2.5 rotate-45 border bg-surface border-border-brand ${
            above
              ? 'top-full -mt-1.5 border-t-0 border-l-0'
              : 'bottom-full -mb-1.5 border-b-0 border-r-0'
          }`} />
          <div className="relative">
            <div className="font-semibold text-foreground mb-1">{term}</div>
            <div className="text-text-secondary text-xs leading-relaxed">{entry.de}</div>
            <div className="text-text-secondary/60 text-[0.65rem] mt-1.5 italic">{entry.en}</div>
          </div>
        </div>
      )}
    </span>
  );
}
