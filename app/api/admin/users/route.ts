import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';
import { db } from '@/lib/db';

/** Resolve the caller and require an APPROVED ADMIN; else null. */
async function requireAdmin(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || user.role !== 'ADMIN' || user.status !== 'APPROVED') return null;
  return user;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin only.' }, { status: 403 });
  }
  const users = await db.user.findMany({
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    select: {
      id: true,
      email: true,
      status: true,
      role: true,
      createdAt: true,
      approvedAt: true,
    },
  });
  return NextResponse.json({ users });
}

const ALLOWED = new Set(['APPROVED', 'PENDING', 'BLOCKED']);

export async function PATCH(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) {
    return NextResponse.json({ error: 'forbidden', message: 'Admin only.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid_input', message: 'Bad JSON.' }, { status: 400 });
  }
  const userId = String((body as { userId?: unknown })?.userId ?? '');
  const status = String((body as { status?: unknown })?.status ?? '');

  if (!userId || !ALLOWED.has(status)) {
    return NextResponse.json(
      { error: 'invalid_input', message: 'userId and a valid status are required.' },
      { status: 400 },
    );
  }
  // An admin can't change their own status — avoids locking yourself out.
  if (userId === admin.id) {
    return NextResponse.json(
      { error: 'self_change', message: 'Sie können Ihr eigenes Konto nicht ändern.' },
      { status: 400 },
    );
  }

  const updated = await db.user.update({
    where: { id: userId },
    data: {
      status: status as 'APPROVED' | 'PENDING' | 'BLOCKED',
      approvedAt: status === 'APPROVED' ? new Date() : null,
    },
    select: { id: true, email: true, status: true, role: true },
  });
  return NextResponse.json({ user: updated });
}
