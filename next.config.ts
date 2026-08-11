import type { NextConfig } from "next";
import { hstsEnabled } from "./lib/deployment";

// HSTS is sent ONLY for a confirmed HTTPS deployment. A local build (localhost
// or an http LAN host) must never HSTS-pin a hostname — that would lock a user
// out of their own machine over http for two years with no TLS to satisfy.
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-DNS-Prefetch-Control', value: 'on' },
  ...(hstsEnabled()
    ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }]
    : []),
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          ...securityHeaders,
          {
            // microphone=(self) allows the site's OWN voice feature
            // (AegisVoiceButton); `()` forbids the mic for every origin incl.
            // self, which silently broke the in-app voice input. camera and
            // geolocation stay fully disabled.
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(self), geolocation=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
