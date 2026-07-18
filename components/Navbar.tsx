'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import {
  getServerSnapshot as aegisGetServerSnapshot,
  getSnapshot as aegisGetSnapshot,
  subscribe as aegisSubscribe,
} from '@/lib/aegis/client-store';
import { AccountMenu, type MeUser } from '@/components/AccountMenu';

const NAV_ITEMS = [
  { href: '/', label: 'Start' },
  { href: '/kb', label: 'Wissensbasis' },
  { href: '/library', label: 'Bibliothek' },
  { href: '/standards', label: 'Standards' },
  { href: '/crosswalk', label: 'Querverweise' },
  { href: '/regulatory-news', label: 'Regulatorik News' },
];

// Role-aware items after the AEGIS link: "Historie" (own conversations) for
// every signed-in user; "Dashboard" (cross-user usage telemetry) admin-only.
// Showing these to users who would only be bounced by the page guard turns
// nav items into broken promises (finding F1).
const HISTORY_ITEM = { href: '/history', label: 'Historie' };
const DASHBOARD_ITEM = { href: '/dashboard', label: 'Dashboard' };

/**
 * Signed-in identity for the nav, re-checked on navigation (same cadence the
 * AccountMenu used before the state was lifted here).
 */
function useMe(): { user: MeUser | null; loaded: boolean; clearUser: () => void } {
  const pathname = usePathname();
  const [user, setUser] = useState<MeUser | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/me');
        const data = await res.json();
        if (!cancelled) setUser(data.user ?? null);
      } catch {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pathname]);

  const clearUser = useCallback(() => setUser(null), []);
  return { user, loaded, clearUser };
}

const AEGIS_LINK = { href: '/aegis', label: 'AEGIS' };

function CompassIcon() {
  return (
    <svg
      className="animate-spin-slow w-6 h-6 shrink-0 text-text-secondary"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" strokeWidth="1.2" />
      <line x1="12" y1="1.5" x2="12" y2="3.5" stroke="currentColor" strokeWidth="1" />
      <line x1="12" y1="20.5" x2="12" y2="22.5" stroke="currentColor" strokeWidth="1" />
      <line x1="1.5" y1="12" x2="3.5" y2="12" stroke="currentColor" strokeWidth="1" />
      <line x1="20.5" y1="12" x2="22.5" y2="12" stroke="currentColor" strokeWidth="1" />
      <polygon points="12,3 13.5,12 12,11 10.5,12" fill="#00BFFF" />
      <polygon points="12,21 13.5,12 12,13 10.5,12" fill="currentColor" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </svg>
  );
}

function ThemeToggle() {
  const [dark, setDark] = useState(true);

  useEffect(() => {
    const saved = localStorage.getItem('theme');
    const isDark = saved ? saved === 'dark' : true;
    setDark(isDark);
    document.documentElement.classList.toggle('dark', isDark);
  }, []);

  function toggle() {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  }

  const gradient = dark
    ? 'from-blue-500 to-cyan-400'
    : 'from-orange-400 to-red-500';

  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      aria-pressed={dark}
      className={`relative w-14 h-7 rounded-full p-0.5 bg-gradient-to-r ${gradient} transition-colors`}
    >
      <span className="absolute inset-0.5 rounded-full bg-background" />
      <span
        className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-gradient-to-br ${gradient} flex items-center justify-center text-white shadow-md transition-transform duration-300 ease-out ${dark ? 'translate-x-7' : 'translate-x-0'}`}
      >
        {dark ? (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2.5v1.5M12 20v1.5M4.5 4.5l1.1 1.1M18.4 18.4l1.1 1.1M2.5 12H4M20 12h1.5M4.5 19.5l1.1-1.1M18.4 5.6l1.1-1.1" />
          </svg>
        )}
      </span>
    </button>
  );
}

function AegisNavbarLink() {
  // Subscribes to the AEGIS store so we can show a pulsing dot whenever
  // a request is in flight, regardless of which route the user is on.
  const state = useSyncExternalStore(
    aegisSubscribe,
    aegisGetSnapshot,
    aegisGetServerSnapshot,
  );
  const loading = state.isLoading;
  return (
    <Link
      href={AEGIS_LINK.href}
      className="relative inline-flex items-center gap-1.5 text-sm font-semibold text-brand-primary hover:text-cyan-300 transition-colors whitespace-nowrap px-2.5 py-1 rounded-md border border-brand-primary/40 bg-brand-primary/10 hover:bg-brand-primary/20 shadow-[0_0_12px_rgba(0,191,255,0.25)] hover:shadow-[0_0_16px_rgba(0,191,255,0.45)]"
      aria-label={loading ? 'AEGIS — Anfrage läuft' : 'AEGIS — KI-Regulatorik-Berater'}
    >
      {loading ? (
        <span className="relative inline-flex h-2 w-2" aria-hidden="true">
          <span className="absolute inset-0 animate-ping rounded-full bg-brand-primary opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-brand-primary" />
        </span>
      ) : null}
      {AEGIS_LINK.label}
    </Link>
  );
}

export function Navbar() {
  const { user, loaded, clearUser } = useMe();
  return (
    <nav className="sticky top-0 z-50 bg-nav border-b border-border-brand">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-lg font-bold text-foreground tracking-tight font-heading shrink-0">
            <CompassIcon />
            RegCompass
          </Link>
          <div className="flex items-center gap-5">
            {NAV_ITEMS.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm text-text-secondary hover:text-brand-primary transition-colors whitespace-nowrap"
              >
                {item.label}
              </Link>
            ))}
            <AegisNavbarLink />
            {[
              ...(user ? [HISTORY_ITEM] : []),
              ...(user?.role === 'ADMIN' ? [DASHBOARD_ITEM] : []),
            ].map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-sm text-text-secondary hover:text-brand-primary transition-colors whitespace-nowrap"
              >
                {item.label}
              </Link>
            ))}
          </div>
          <div className="flex items-center gap-4 shrink-0">
            <AccountMenu user={user} loaded={loaded} onLogout={clearUser} />
            <ThemeToggle />
          </div>
        </div>
      </div>
    </nav>
  );
}
