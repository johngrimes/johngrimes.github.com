/**
 * Static file server that mimics GitHub Pages closely enough for tests and
 * local preview: directories serve their index.html, and directory paths
 * without a trailing slash redirect to the slashed form.
 *
 * @author John Grimes
 */

import { stat } from "node:fs/promises";
import { join, normalize } from "node:path";

const root = join(import.meta.dir, "..");
const port = Number(process.env.PORT ?? 4173);

Bun.serve({
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const path = join(root, normalize(decodeURIComponent(pathname)));
    if (!path.startsWith(root)) {
      return new Response("Not found", { status: 404 });
    }
    const info = await stat(path).catch(() => null);
    if (info?.isDirectory()) {
      if (!pathname.endsWith("/")) {
        return Response.redirect(`${pathname}/`, 301);
      }
      return serveFile(join(path, "index.html"));
    }
    return info ? serveFile(path) : new Response("Not found", { status: 404 });
  },
});

console.log(`Serving ${root} at http://localhost:${port}/`);

/**
 * Serves a single file, or a 404 if it does not exist.
 *
 * @param path - Absolute path of the file to serve.
 * @returns The HTTP response.
 */
async function serveFile(path: string): Promise<Response> {
  const file = Bun.file(path);
  return (await file.exists())
    ? new Response(file)
    : new Response("Not found", { status: 404 });
}
