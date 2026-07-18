import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest } from '@/lib/auth';

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ user: null });
  return NextResponse.json({
    user: {
      email: user.email,
      username: user.username,
      status: user.status,
      role: user.role,
    },
  });
}
