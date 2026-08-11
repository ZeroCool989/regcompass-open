import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertBindingAllowed,
  BindingRefusedError,
  cookiesSecure,
  envFlag,
  hstsEnabled,
  isHostedDeployment,
  isLoopbackHost,
  requiresRealSecrets,
  usesHttps,
  type Env,
} from '@/lib/deployment';
import { checkCronAuth } from '@/lib/regulatory/cron-auth';

// Named deployment modes → the env that characterizes each.
const MODES: Record<string, Env> = {
  devLocalhost: {},
  prodLocalhost: { NODE_ENV: 'production' },
  httpLan: { NODE_ENV: 'production', REGCOMPASS_HOST: '0.0.0.0' },
  hostedHttps: { REGCOMPASS_HOSTED: '1', APP_BASE_URL: 'https://regcompass.example' },
  vercel: { VERCEL: '1', VERCEL_ENV: 'production' },
};

describe('envFlag — strict boolean parsing', () => {
  it('treats only explicit truthy tokens as true', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on']) {
      expect(envFlag('X', { X: v }), v).toBe(true);
    }
  });
  it('never treats "false"/"0"/"no"/"off"/unset as true (the Boolean("false") footgun)', () => {
    for (const v of ['false', '0', 'no', 'off', '', '  ', 'anything']) {
      expect(envFlag('X', { X: v }), v).toBe(false);
    }
    expect(envFlag('X', {})).toBe(false);
  });
});

describe('deployment matrix', () => {
  const expected = {
    devLocalhost: { hosted: false, https: false, secure: false, hsts: false, realSecrets: false },
    prodLocalhost: { hosted: false, https: false, secure: false, hsts: false, realSecrets: false },
    httpLan: { hosted: false, https: false, secure: false, hsts: false, realSecrets: false },
    hostedHttps: { hosted: true, https: true, secure: true, hsts: true, realSecrets: true },
    vercel: { hosted: true, https: true, secure: true, hsts: true, realSecrets: true },
  } as const;

  for (const [mode, env] of Object.entries(MODES)) {
    it(`${mode}: hosted/https/secure/hsts/realSecrets`, () => {
      const e = expected[mode as keyof typeof expected];
      expect(isHostedDeployment(env), 'hosted').toBe(e.hosted);
      expect(usesHttps(env), 'https').toBe(e.https);
      expect(cookiesSecure(env), 'secure').toBe(e.secure);
      expect(hstsEnabled(env), 'hsts').toBe(e.hsts);
      expect(requiresRealSecrets(env), 'realSecrets').toBe(e.realSecrets);
    });
  }

  it('NODE_ENV=production alone is NOT hosted and NOT https (local prod build stays local)', () => {
    expect(isHostedDeployment({ NODE_ENV: 'production' })).toBe(false);
    expect(usesHttps({ NODE_ENV: 'production' })).toBe(false);
  });

  it('REGCOMPASS_HOSTED="false" does not accidentally enable hosted mode', () => {
    expect(isHostedDeployment({ REGCOMPASS_HOSTED: 'false' })).toBe(false);
  });

  it('an http APP_BASE_URL is not treated as HTTPS', () => {
    expect(usesHttps({ APP_BASE_URL: 'http://192.168.1.20:3000' })).toBe(false);
  });
});

describe('hosted-only endpoint authorization (news refresh cron)', () => {
  it('local (not hosted) stays callable without a secret', () => {
    const r = checkCronAuth(null, { secret: undefined, deployed: isHostedDeployment(MODES.prodLocalhost) });
    expect(r.ok).toBe(true);
  });
  it('hosted without a secret is refused (503)', () => {
    const r = checkCronAuth(null, { secret: undefined, deployed: isHostedDeployment(MODES.vercel) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(503);
  });
  it('hosted with the correct bearer is allowed', () => {
    const r = checkCronAuth('Bearer s3cret', { secret: 's3cret', deployed: isHostedDeployment(MODES.hostedHttps) });
    expect(r.ok).toBe(true);
  });
});

describe('LAN binding guard — refuse, not warn (assertBindingAllowed)', () => {
  it('loopback classification', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]', '']) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ['0.0.0.0', '192.168.1.20', 'mybox.local', '::']) expect(isLoopbackHost(h), h).toBe(false);
  });

  it('default loopback + local auth → allowed', () => {
    expect(assertBindingAllowed({})).toBe('127.0.0.1');
  });

  it('explicit loopback + local auth → allowed', () => {
    expect(assertBindingAllowed({ REGCOMPASS_HOST: 'localhost', AUTH_MODE: 'local' })).toBe('localhost');
    expect(assertBindingAllowed({ REGCOMPASS_HOST: '::1' })).toBe('::1');
  });

  it('0.0.0.0 + local auth → BLOCKED', () => {
    expect(() => assertBindingAllowed({ REGCOMPASS_HOST: '0.0.0.0', AUTH_MODE: 'local' })).toThrow(BindingRefusedError);
  });

  it('LAN address + local auth → BLOCKED', () => {
    expect(() => assertBindingAllowed({ REGCOMPASS_HOST: '192.168.1.20' })).toThrow(BindingRefusedError);
  });

  it('non-loopback + authenticated (AUTH_MODE=multi) → allowed', () => {
    expect(assertBindingAllowed({ REGCOMPASS_HOST: '0.0.0.0', AUTH_MODE: 'multi' })).toBe('0.0.0.0');
    expect(assertBindingAllowed({ REGCOMPASS_HOST: '192.168.1.20', AUTH_MODE: 'multi' })).toBe('192.168.1.20');
  });

  it('hosted flag does NOT bypass the rule — non-loopback still needs multi', () => {
    expect(() => assertBindingAllowed({ REGCOMPASS_HOST: '0.0.0.0', REGCOMPASS_HOSTED: '1', AUTH_MODE: 'local' })).toThrow(
      BindingRefusedError,
    );
    expect(assertBindingAllowed({ REGCOMPASS_HOST: '0.0.0.0', REGCOMPASS_HOSTED: '1', AUTH_MODE: 'multi' })).toBe('0.0.0.0');
  });
});

describe('default loopback binding — one centralized launcher', () => {
  const root = join(__dirname, '..', '..');
  it('pnpm start routes through the centralized launcher; dev stays loopback', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toBe('tsx scripts/start.ts');
    expect(pkg.scripts.dev).toContain('-H 127.0.0.1');
  });
  it('scripts/start.ts enforces the binding rule via assertBindingAllowed', () => {
    const start = readFileSync(join(root, 'scripts', 'start.ts'), 'utf8');
    expect(start).toContain('assertBindingAllowed');
  });
  it('bin/regcompass-open delegates the production serve to scripts/start.ts', () => {
    const bin = readFileSync(join(root, 'bin', 'regcompass-open'), 'utf8');
    expect(bin).toContain("'scripts/start.ts'");
    expect(bin).not.toContain('warnIfNetworkExposed'); // hard refusal replaced the warning
  });
});
