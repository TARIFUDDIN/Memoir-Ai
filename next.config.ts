import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },

  typescript: {
    ignoreBuildErrors: true
  },
} as NextConfig;

export default withSentryConfig( nextConfig, {
  // Source map upload auth token (see Source Maps section below)
  authToken: process.env.SENTRY_AUTH_TOKEN,

  // Upload wider set of client source files for better stack trace resolution
  widenClientFileUpload: true,

  // Create a proxy API route to bypass ad-blockers
  tunnelRoute: "/monitoring",

  // Suppress non-CI output
  silent: !process.env.CI,
} );
