import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { checkEnv } from '@/lib/env';

export async function GET() {
  try {
    checkEnv();
    const count = await db.aegisUsageLog.count();
    return NextResponse.json({
      status: 'ok',
      database: 'connected',
      aegisLogCount: count,
      aiAvailable: !!process.env.ANTHROPIC_API_KEY,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json(
      { status: 'error', message: error instanceof Error ? error.message : 'unknown' },
      { status: 500 }
    );
  }
}
