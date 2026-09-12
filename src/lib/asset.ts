/**
 * asset — resolve a file in `public/` against the deployment base path.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * Vite rewrites asset URLs it can see in markup and in imports. It does NOT
 * rewrite string literals, so `href="/labs/encodings.zip"` ships verbatim — and
 * under a project-site deploy the site lives at /columnspaces/, where that URL
 * resolves to the domain root and 404s. Every forge-lab download was broken in
 * production while all six zips sat correctly on disk, because the bug is
 * invisible locally: `npm run dev` serves from / and the link works.
 *
 * `import.meta.env.BASE_URL` is '/' in dev and '/columnspaces/' in the deployed
 * build, and it always ends in a slash, so this is the whole fix.
 *
 * Router links do NOT need this — react-router already has the basename.
 * This is only for things fetched or linked as files: zips, markdown exports,
 * images, traces.
 */
export function asset(path: string): string {
  const base = import.meta.env.BASE_URL || '/'
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}
