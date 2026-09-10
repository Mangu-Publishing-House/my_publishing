/** @type {import('next').NextConfig} */

// PERF-PHASE2-8 — Bundle analyzer
const withBundleAnalyzer = require('@next/bundle-analyzer')({
  enabled: process.env.ANALYZE === 'true',
});

// NOTE: NEXT_PUBLIC_* values are inlined into client bundles by Next.js at build
// time and are read from the real environment. No fallbacks are defined here —
// missing values must fail the build/deploy loudly (never silently point the app
// at the wrong backend). See scripts/validate-env.ts and instrumentation.ts.

// Build a Content-Security-Policy that covers all required third-party origins.
// 'unsafe-inline' / 'unsafe-eval' are required by Next.js 14 until nonce-based
// CSP is fully wired in; tighten further by replacing them with nonces once the
// application supports it.
const ContentSecurityPolicy = [
  "default-src 'self'",
  // Next.js inline scripts and client-side hydration require 'unsafe-inline'.
  // Stripe JS also needs to load from js.stripe.com.
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://js.stripe.com https://checkout.stripe.com",
  // Tailwind/CSS-in-JS produces inline styles at runtime.
  "style-src 'self' 'unsafe-inline'",
  // Images come from self, Supabase Storage, Vercel Blob (Phoenix WS3 —
  // inert until STORAGE_PROVIDER=vercel-blob, but required before any
  // cover_url is rewritten to a Blob URL), Stripe, and placeholder services.
  "img-src 'self' data: blob: https://*.supabase.co https://*.public.blob.vercel-storage.com https://picsum.photos https://images.unsplash.com https://q.stripe.com",
  // API calls go to Supabase (REST + Realtime WS) and Stripe.
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.stripe.com https://checkout.stripe.com https://q.stripe.com https://*.sentry.io https://*.ingest.sentry.io",
  // Stripe embeds iframes for secure card input.
  'frame-src https://js.stripe.com https://hooks.stripe.com https://checkout.stripe.com',
  "font-src 'self'",
  // Disallow plugins and object embeds entirely.
  "object-src 'none'",
  // Restrict <base> tag hijacking.
  "base-uri 'self'",
  // Only allow forms to POST to the same origin.
  "form-action 'self'",
  // Prevent this page from being embedded in a foreign frame (replaces X-Frame-Options).
  "frame-ancestors 'none'",
  // Block mixed content.
  'upgrade-insecure-requests',
].join('; ');

const nextConfig = {
  output: process.platform === 'win32' ? undefined : 'standalone',
  async headers() {
    const securityHeaders = [
      { key: 'X-DNS-Prefetch-Control', value: 'on' },
      // HSTS should never be sent from local/dev environments because browsers can cache
      // it and force HTTPS on localhost, which breaks local http:// test runs.
      ...(process.env.NODE_ENV === 'production'
        ? [
            {
              key: 'Strict-Transport-Security',
              value: 'max-age=63072000; includeSubDomains; preload',
            },
          ]
        : []),
      // CSP supersedes X-Frame-Options; keep both for legacy browser coverage.
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      // X-XSS-Protection is deprecated in modern browsers but harmless for older ones.
      { key: 'X-XSS-Protection', value: '1; mode=block' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      {
        key: 'Permissions-Policy',
        value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
      },
      // Prevent popups from retaining opener access (protects OAuth flows).
      { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
      // Restrict how this page's resources can be embedded by cross-origin pages.
      { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
      { key: 'Content-Security-Policy', value: ContentSecurityPolicy },
    ];

    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
    ];
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
      {
        protocol: 'https',
        hostname: 'picsum.photos',
      },
      // Phoenix WS3 — Vercel Blob storage
      {
        protocol: 'https',
        hostname: '*.public.blob.vercel-storage.com',
      },
    ],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '1mb', // PERF-PHASE2-9 — Tighten from 50mb to 1mb
    },
  },
};

// PERF-PHASE2-8 — Only apply Sentry's Next.js wrapper when a DSN is configured.
const analyzedConfig = withBundleAnalyzer(nextConfig);
const sentryDsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

if (!sentryDsn) {
  module.exports = analyzedConfig;
} else {
  const { withSentryConfig } = require('@sentry/nextjs');
  const hasSentryAuthToken = Boolean(process.env.SENTRY_AUTH_TOKEN);

  module.exports = withSentryConfig(analyzedConfig, {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    silent: !hasSentryAuthToken,
    // Avoid source-map upload work when no auth token is available.
    sourcemaps: {
      disable: !hasSentryAuthToken,
    },
    hideSourceMaps: true,
    disableLogger: true,
    automaticVercelMonitors: false,
  });
}
