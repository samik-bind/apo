/** @type {import('next').NextConfig} */
const nextConfig = {
  output: process.env.NEXT_STANDALONE_OUTPUT ? 'standalone' : undefined,
  // Next.js applies gzip/brotli compression to route-handler responses by
  // default. That buffers Server-Sent Events (the /backend-proxy/* streams for
  // run events and trace spans): the browser's EventSource connects but never
  // receives events until disconnect, so every live feed silently breaks.
  // Production deployments typically run behind a reverse proxy (nginx/Caddy)
  // that handles compression, and localhost traffic doesn't need it.
  compress: false,
  // Issue #174: the rewrite proxy defaults to a 30 s response timeout, which
  // kills multi-MB CLI result submissions (`/backend-proxy/…/result`) with a
  // bodyless 500 while the backend is still finalizing. Server-profile
  // deployments now route API traffic straight to the backend in Caddy, but
  // this hop remains for direct-frontend access (local profile, custom
  // ingresses) — give those the same headroom the backend path has.
  experimental: {
    proxyTimeout: 300_000,
  },
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'pub-21fa567153294f0ca87dc79e6f19866a.r2.dev',
        pathname: '/attractions/**',
      },
    ],
  },
  async redirects() {
    return [
      {
        source: '/project/:projectId/agent-tasks/:path*',
        destination: '/project/:projectId/tasks/:path*',
        permanent: false,
      },
      {
        source: '/project/:projectId/agent-tasks',
        destination: '/project/:projectId/tasks',
        permanent: false,
      },
      {
        source: '/project/:projectId/agent-task-schedules/:path*',
        destination: '/project/:projectId/schedules/:path*',
        permanent: false,
      },
      {
        source: '/project/:projectId/agent-task-schedules',
        destination: '/project/:projectId/schedules',
        permanent: false,
      },
    ];
  },
  async rewrites() {
    const backendUrl = process.env.BACKEND_URL || 'http://localhost:8000';
    return [
      // Preserve the canonical OTLP path when traces enter through the public
      // frontend origin. The generic /api rewrite below intentionally strips
      // /api for dashboard routes, so telemetry needs this specific rule first.
      {
        source: '/api/public/otel/:path*',
        destination: `${backendUrl}/api/public/otel/:path*`,
      },
      {
        source: '/api/:path((?!auth(?:/|$)).*)',
        destination: `${backendUrl}/:path*`,
      },
      {
        source: '/backend-proxy/:path*',
        destination: `${backendUrl}/:path*`,
      },
      // SPEC-180: the public origin is also the CLI's backend. ``apo login
      // --backend <public-origin>`` calls /v1/* and /auth/* directly, so those
      // backend-owned paths must resolve on the same origin as the dashboard —
      // the frontend itself serves neither. NextAuth's own /api/auth/* surface
      // is untouched (the /api rewrite above already excludes it).
      {
        source: '/v1/:path*',
        destination: `${backendUrl}/v1/:path*`,
      },
      {
        source: '/auth/:path*',
        destination: `${backendUrl}/auth/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;
