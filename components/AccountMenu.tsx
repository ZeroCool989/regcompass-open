'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

export type MeUser = {
  email: string;
  username: string | null;
  status: 'PENDING' | 'APPROVED' | 'BLOCKED';
  role: 'USER' | 'ADMIN';
};

const STATUS: Record<MeUser['status'], { label: string; cls: string }> = {
  APPROVED: { label: 'Freigegeben', cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
  PENDING: { label: 'Wartet auf Freigabe', cls: 'text-amber-400 bg-amber-500/10 border-amber-500/30' },
  BLOCKED: { label: 'Gesperrt', cls: 'text-red-400 bg-red-500/10 border-red-500/30' },
};

/**
 * Account control for the navbar: an avatar+username trigger that opens a small
 * dropdown dashboard (identity, status, admin/history links, logout). The user
 * state lives in the Navbar (fetched from /api/auth/me per navigation) so the
 * nav items and this menu render from one consistent identity.
 */
export function AccountMenu({
  user,
  loaded,
  onLogout,
}: {
  user: MeUser | null;
  loaded: boolean;
  onLogout: () => void;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close the dropdown on navigation.
  useEffect(() => setOpen(false), [pathname]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const logout = useCallback(async () => {
    setLoggingOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* navigate regardless */
    }
    setOpen(false);
    onLogout();
    router.replace('/login');
    router.refresh();
  }, [router, onLogout]);

  if (!loaded) return null;

  if (!user) {
    return (
      <Link
        href="/login"
        className="text-sm font-semibold text-brand-primary hover:text-cyan-300 transition-colors whitespace-nowrap px-2.5 py-1 rounded-md border border-brand-primary/40 bg-brand-primary/10 hover:bg-brand-primary/20"
      >
        Anmelden
      </Link>
    );
  }

  const name = user.username || user.email.split('@')[0];
  const initial = name.charAt(0).toUpperCase();
  const status = STATUS[user.status];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full pl-1 pr-2.5 py-1 border border-border-brand hover:border-brand-primary/50 hover:bg-surface/60 transition-colors"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-primary/20 text-brand-primary text-sm font-bold border border-brand-primary/40">
          {initial}
        </span>
        <span className="hidden sm:inline text-sm font-medium text-foreground max-w-[10rem] truncate">
          {name}
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`text-text-secondary transition-transform ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 mt-2 w-64 rounded-xl border border-border-brand bg-surface shadow-xl shadow-black/30 overflow-hidden z-50"
        >
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border-brand/60">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-primary/20 text-brand-primary text-lg font-bold border border-brand-primary/40 shrink-0">
              {initial}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground truncate">{name}</div>
              <div className="text-xs text-text-secondary truncate" title={user.email}>
                {user.email}
              </div>
            </div>
          </div>

          <div className="px-4 py-2.5 border-b border-border-brand/60 flex items-center gap-2">
            <span className={`text-[0.7rem] px-2 py-0.5 rounded border ${status.cls}`}>
              {status.label}
            </span>
            {user.role === 'ADMIN' ? (
              <span className="text-[0.7rem] px-2 py-0.5 rounded border border-brand-primary/40 text-brand-primary bg-brand-primary/10">
                Admin
              </span>
            ) : null}
          </div>

          <nav className="py-1">
            <Link
              href="/history"
              role="menuitem"
              className="block px-4 py-2 text-sm text-text-secondary hover:text-foreground hover:bg-background/60 transition-colors no-underline"
            >
              Meine Gespräche
            </Link>
            <Link
              href="/account/soul"
              role="menuitem"
              className="block px-4 py-2 text-sm text-text-secondary hover:text-foreground hover:bg-background/60 transition-colors no-underline"
            >
              Personalisierung
            </Link>
            <Link
              href="/account/voice"
              role="menuitem"
              className="block px-4 py-2 text-sm text-text-secondary hover:text-foreground hover:bg-background/60 transition-colors no-underline"
            >
              Aegis-Stimme
            </Link>
            {user.role === 'ADMIN' ? (
              <Link
                href="/admin/users"
                role="menuitem"
                className="block px-4 py-2 text-sm text-text-secondary hover:text-foreground hover:bg-background/60 transition-colors no-underline"
              >
                Benutzerverwaltung
              </Link>
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={logout}
              disabled={loggingOut}
              className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50"
            >
              {loggingOut ? 'Wird abgemeldet…' : 'Abmelden'}
            </button>
          </nav>
        </div>
      ) : null}
    </div>
  );
}
