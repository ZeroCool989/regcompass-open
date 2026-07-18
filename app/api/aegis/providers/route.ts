import { NextResponse, type NextRequest } from 'next/server';
import { getUserFromRequest, isApproved } from '@/lib/auth';
import {
  deleteProviderCredential,
  listProviderSettings,
  parseProvider,
  setPreferredProvider,
  upsertProviderCredential,
} from '@/lib/aegis/provider-settings';

async function approvedUser(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user || !isApproved(user)) return null;
  return user;
}

export async function GET(req: NextRequest) {
  const user = await approvedUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized', message: 'Bitte anmelden.' }, { status: 401 });
  return NextResponse.json(await listProviderSettings(user.id));
}

export async function PUT(req: NextRequest) {
  const user = await approvedUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized', message: 'Bitte anmelden.' }, { status: 401 });
  const body = await req.json().catch(() => null) as { provider?: unknown; apiKey?: unknown; preferredModel?: unknown } | null;
  const provider = parseProvider(body?.provider);
  if (!provider) return NextResponse.json({ error: 'invalid_input', message: 'Unbekannter Provider.' }, { status: 400 });
  if (typeof body?.apiKey !== 'string') return NextResponse.json({ error: 'invalid_input', message: 'API Key fehlt.' }, { status: 400 });
  try {
    await upsertProviderCredential({
      userId: user.id,
      provider,
      apiKey: body.apiKey,
      preferredModel: typeof body.preferredModel === 'string' ? body.preferredModel : null,
    });
    return NextResponse.json(await listProviderSettings(user.id));
  } catch (err) {
    return NextResponse.json({ error: 'invalid_input', message: err instanceof Error ? err.message : 'Konnte Credential nicht speichern.' }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  const user = await approvedUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized', message: 'Bitte anmelden.' }, { status: 401 });
  const body = await req.json().catch(() => null) as { preferredProvider?: unknown } | null;
  const provider = body?.preferredProvider === null ? null : parseProvider(body?.preferredProvider);
  if (body?.preferredProvider !== null && !provider) return NextResponse.json({ error: 'invalid_input', message: 'Unbekannter Provider.' }, { status: 400 });
  if (provider && provider !== 'ANTHROPIC') {
    return NextResponse.json({
      error: 'unsupported_provider',
      message: 'Dieser Provider ist gespeichert, aber für AEGIS noch nicht runtime-freigegeben. Bitte Anthropic wählen.',
    }, { status: 400 });
  }
  await setPreferredProvider(user.id, provider);
  return NextResponse.json(await listProviderSettings(user.id));
}

export async function DELETE(req: NextRequest) {
  const user = await approvedUser(req);
  if (!user) return NextResponse.json({ error: 'unauthorized', message: 'Bitte anmelden.' }, { status: 401 });
  const provider = parseProvider(req.nextUrl.searchParams.get('provider'));
  if (!provider) return NextResponse.json({ error: 'invalid_input', message: 'Unbekannter Provider.' }, { status: 400 });
  await deleteProviderCredential(user.id, provider);
  return NextResponse.json(await listProviderSettings(user.id));
}
