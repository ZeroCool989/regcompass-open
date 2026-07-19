'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Logs the user out (clears the rc_auth cookie via /api/auth/logout) and sends
 * them to /login. Used in the Aegis header and the access-notice screen.
 */
export function AegisLogoutButton({
  className,
  children = 'Abmelden',
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      /* ignore — navigate regardless */
    }
    router.replace('/login');
    router.refresh();
  }, [router]);

  return (
    <button type="button" onClick={onClick} disabled={busy} className={className}>
      {children}
    </button>
  );
}
