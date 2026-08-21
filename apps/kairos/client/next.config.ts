import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // @kairos/auth ships .ts source for type resolution + .js dist for
  // runtime; Next transpiles the source so we don't need a build step
  // on the package side during dev.
  transpilePackages: ["@kairos/auth"],
};

export default nextConfig;
