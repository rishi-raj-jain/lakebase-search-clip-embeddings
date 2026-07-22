import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /**
   * onnxruntime-node and sharp are native N-API addons. Bundling them would
   * inline JavaScript wrappers around `.node` binaries that are not there at
   * runtime, so they are left external and required from node_modules.
   */
  serverExternalPackages: ['@huggingface/transformers', 'onnxruntime-node', 'sharp'],

  /**
   * The tracer cannot see these, so they have to be named.
   *
   * File tracing follows `require()` and `import`, which finds
   * `onnxruntime_binding.node` but stops there. That addon then `dlopen`s
   * `libonnxruntime.so.1` at runtime, and a dynamic link is invisible to static
   * analysis. The deploy therefore succeeded and the function failed on first
   * use with:
   *
   *   Failed to load external module @huggingface/transformers:
   *   libonnxruntime.so.1: cannot open shared object file
   *
   * Only the runtime's own architecture is included. Vercel functions are
   * linux/x64, and shipping the darwin, win32 and arm64 copies as well would
   * add tens of megabytes against the 250MB bundle limit for nothing.
   */
  outputFileTracingIncludes: {
    '/api/search': ['./node_modules/onnxruntime-node/bin/napi-v3/linux/x64/**', './node_modules/@img/sharp-linux-x64/**', './node_modules/@img/sharp-libvips-linux-x64/**'],
  },
}

export default nextConfig
