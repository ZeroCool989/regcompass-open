'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  dismissLatestCompletion,
  getServerSnapshot,
  getSnapshot,
  subscribe,
} from '@/lib/aegis/client-store';

/**
 * Global in-app banner that appears on every route except /aegis when
 * an AEGIS response arrives. Complements the browser Notification API:
 * the banner fires regardless of OS-level notification permission, so
 * users always see that the analysis finished.
 *
 * Rendered once in app/layout.tsx so it survives route navigation.
 */
export function AegisNotificationBanner() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const pathname = usePathname();

  // Tracks which completion id the user has already acknowledged. Initialised
  // from the current snapshot so completions that happened before mount
  // don't trigger a stale banner.
  const [seenId, setSeenId] = useState<string | null>(
    () => getSnapshot().latestCompletion?.id ?? null,
  );

  // When the user navigates to /aegis, treat the current completion as
  // seen (they're looking at the chat now).
  useEffect(() => {
    if (pathname === '/aegis' && state.latestCompletion) {
      setSeenId(state.latestCompletion.id);
    }
  }, [pathname, state.latestCompletion]);

  // Auto-dismiss after 10 seconds.
  useEffect(() => {
    const c = state.latestCompletion;
    if (!c) return;
    if (c.id === seenId) return;
    if (pathname === '/aegis') return;
    const t = window.setTimeout(() => {
      setSeenId(c.id);
      dismissLatestCompletion();
    }, 10_000);
    return () => window.clearTimeout(t);
  }, [state.latestCompletion, seenId, pathname]);

  const c = state.latestCompletion;
  if (!c) return null;
  if (c.id === seenId) return null;
  if (pathname === '/aegis') return null;

  function handleDismiss() {
    setSeenId(c!.id);
    dismissLatestCompletion();
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed top-16 right-4 z-[60] w-[min(360px,calc(100vw-2rem))] step-fade-in"
    >
      <div className="rounded-xl border border-brand-primary/40 bg-surface/95 backdrop-blur shadow-[0_0_20px_rgba(0,191,255,0.2)] p-3 pr-2 flex items-start gap-3">
        <div className="mt-0.5 w-2.5 h-2.5 rounded-full bg-brand-primary shrink-0 relative">
          <span className="absolute inset-0 rounded-full bg-brand-primary animate-ping opacity-70" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-foreground leading-snug">
            AEGIS — Analyse fertig
          </div>
          <div className="text-xs text-text-secondary mt-0.5 truncate">
            {c.mode} · {c.citations} Quellen · {(c.latency / 1000).toFixed(1)} s
          </div>
          <div className="mt-2 flex items-center gap-3">
            <Link
              href="/aegis"
              onClick={handleDismiss}
              className="text-xs font-semibold text-brand-primary hover:text-cyan-300 transition-colors"
            >
              Anzeigen →
            </Link>
            <button
              type="button"
              onClick={handleDismiss}
              className="text-xs text-text-secondary hover:text-foreground transition-colors"
            >
              Schliessen
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
