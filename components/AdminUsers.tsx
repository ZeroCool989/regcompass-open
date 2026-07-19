'use client';

import { useCallback, useEffect, useState } from 'react';

type AdminUser = {
  id: string;
  email: string;
  status: 'PENDING' | 'APPROVED' | 'BLOCKED';
  role: 'USER' | 'ADMIN';
  createdAt: string;
  approvedAt: string | null;
};

const STATUS_STYLE: Record<AdminUser['status'], string> = {
  PENDING: 'text-amber-400 bg-amber-500/10 border-amber-500/30',
  APPROVED: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30',
  BLOCKED: 'text-red-400 bg-red-500/10 border-red-500/30',
};

export function AdminUsers({ selfId }: { selfId: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch('/api/admin/users');
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message ?? 'Fehler beim Laden.');
      setUsers(data.users);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const setStatus = useCallback(
    async (userId: string, status: AdminUser['status']) => {
      setBusyId(userId);
      setError(null);
      try {
        const res = await fetch('/api/admin/users', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId, status }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message ?? 'Aktion fehlgeschlagen.');
        setUsers((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, status: data.user.status } : u)),
        );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusyId(null);
      }
    },
    [],
  );

  if (loading) return <p className="text-sm text-text-secondary">Lädt…</p>;

  const pending = users.filter((u) => u.status === 'PENDING');

  return (
    <div className="space-y-6">
      {error ? (
        <div className="text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      ) : null}

      {pending.length > 0 ? (
        <p className="text-sm text-amber-400">
          {pending.length} Konto(s) warten auf Freigabe.
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-lg border border-border-brand">
        <table className="min-w-full text-sm">
          <thead className="bg-surface/60 text-text-secondary">
            <tr>
              <th className="text-left px-4 py-2.5 font-semibold">E-Mail</th>
              <th className="text-left px-4 py-2.5 font-semibold">Status</th>
              <th className="text-left px-4 py-2.5 font-semibold">Rolle</th>
              <th className="text-right px-4 py-2.5 font-semibold">Aktionen</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const isSelf = u.id === selfId;
              const busy = busyId === u.id;
              return (
                <tr key={u.id} className="border-t border-border-brand/40">
                  <td className="px-4 py-2.5 font-mono text-xs">
                    {u.email}
                    {isSelf ? <span className="ml-2 text-text-secondary/60">(Sie)</span> : null}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`px-2 py-0.5 text-xs rounded border ${STATUS_STYLE[u.status]}`}>
                      {u.status}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-text-secondary">{u.role}</td>
                  <td className="px-4 py-2.5 text-right space-x-2 whitespace-nowrap">
                    {isSelf ? (
                      <span className="text-xs text-text-secondary/50">—</span>
                    ) : (
                      <>
                        {u.status !== 'APPROVED' ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setStatus(u.id, 'APPROVED')}
                            className="text-xs px-2.5 py-1 rounded border border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-50 transition-colors"
                          >
                            Freigeben
                          </button>
                        ) : null}
                        {u.status !== 'BLOCKED' ? (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setStatus(u.id, 'BLOCKED')}
                            className="text-xs px-2.5 py-1 rounded border border-red-500/40 text-red-400 hover:bg-red-500/10 disabled:opacity-50 transition-colors"
                          >
                            Sperren
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setStatus(u.id, 'PENDING')}
                            className="text-xs px-2.5 py-1 rounded border border-border-brand text-text-secondary hover:text-foreground disabled:opacity-50 transition-colors"
                          >
                            Entsperren
                          </button>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
