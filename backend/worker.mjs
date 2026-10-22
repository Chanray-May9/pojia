/**
 * Cloudflare Worker 入口。
 * wrangler.toml 中 main = "../backend/worker.mjs"
 */
import { handleApi } from './app.mjs';

export default {
  async fetch(request, env, ctx) {
    return handleApi(request, env, ctx);
  },
};
