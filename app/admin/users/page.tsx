import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { AdminUsers } from '@/components/AdminUsers';
import { getUserFromCookies, isApproved } from '@/lib/auth';

export const metadata: Metadata = {
  title: 'Benutzerverwaltung — RegCompass',
};

export default async function AdminUsersPage() {
  const user = await getUserFromCookies();
  if (!user) redirect('/login?next=/admin/users');
  // Approved admins only; everyone else is bounced (no info leak about the page).
  if (user.role !== 'ADMIN' || !isApproved(user)) redirect('/aegis');

  return (
    <div className="max-w-4xl mx-auto px-6 py-10">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-heading font-bold">Benutzerverwaltung</h1>
          <p className="text-sm text-text-secondary mt-1">
            Geben Sie neue Konten frei oder sperren Sie den Zugang zu AEGIS.
          </p>
        </div>
        <Link
          href="/aegis"
          className="text-sm text-text-secondary hover:text-brand-primary transition-colors no-underline shrink-0"
        >
          ← AEGIS
        </Link>
      </div>
      <AdminUsers selfId={user.id} />
    </div>
  );
}
