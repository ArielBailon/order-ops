import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The repo root has its own lockfile, so Next would pick it as the workspace root and watch the
  // whole repo; any file written there (logs, test output) would reload the console in dev.
  turbopack: { root: __dirname },
};

export default nextConfig;
