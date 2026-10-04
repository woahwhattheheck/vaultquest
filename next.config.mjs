import path from "path";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@vaultquest/stellar-wallet-connect"],
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@react-native-async-storage/async-storage": path.resolve(
        "./lib/shims/async-storage.js",
      ),
    };
    // @vaultquest/stellar-wallet-connect's source uses explicit ".js" specifiers
    // for its own ".ts"/".tsx" files (valid, standard ESM-style relative
    // imports) — webpack doesn't resolve those against TS sources without this.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".js", ".ts", ".tsx"],
    };
    return config;
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    remotePatterns: [],
  },
};

export default nextConfig;
