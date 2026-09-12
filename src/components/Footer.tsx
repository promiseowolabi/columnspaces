import { Link } from 'react-router'
import { TRACKS, TOTAL_TRACK_LESSONS as TOTAL_LESSON_COUNT } from '@/lib/tracks'
/* Same reason as Navbar: the footer is in the entry chunk, so it may not import
   the lesson metadata manifest. The registry total is the same 54. */

/**
 * Every built surface gets a footer entry. Checked against App.tsx's route
 * table by tests/site.test.ts — see the note in Navbar.
 */
const LEARN_LINKS = [
  { to: '/curriculum', label: 'Curriculum' },
  { to: '/warehouse', label: 'Warehouse' },
  { to: '/labs', label: 'Labs' },
  { to: '/drills', label: 'Drills' },
  { to: '/desks', label: 'Desks' },
  { to: '/rooms', label: 'Design Review' },
  { to: '/capstone', label: 'Capstone' },
  { to: '/progress', label: 'Progress' },
]

/**
 * External and generated surfaces only. The previous `#method` / `#faq`
 * anchors pointed at sections that do not exist on any page, and the GitHub
 * entry pointed at github.com itself.
 *
 * `llms.txt` is a static file in public/, so it needs BASE_URL — the Pages
 * deploy serves the app from /columnspaces/, not from the root.
 */
const META_LINKS = [
  { href: `${import.meta.env.BASE_URL}llms.txt`, label: 'llms.txt' },
  { href: 'https://github.com/promiseowolabi/columnspaces', label: 'GitHub', external: true },
]

/**
 * Footer (design.md §9.14) — marketing routes only; app routes keep StatusBar.
 * Top border carries a 64px blueprint grid strip fading out.
 */
export default function Footer() {
  return (
    <footer className="relative border-t border-line">
      {/* blueprint grid strip fading out */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 -top-16 h-16 bg-blueprint [mask-image:linear-gradient(to_top,black,transparent)]"
      />
      <div className="mx-auto max-w-app px-6 py-16 lg:px-12">
        <div className="grid gap-12 md:grid-cols-[1.4fr_1fr_1fr]">
          {/* Brand */}
          <div>
            <Link to="/" className="font-mono text-[15px] font-medium text-text-1">
              [<span className="wordmark-cursor" />]_columnspaces
            </Link>
            <p className="mt-4 max-w-xs font-display text-h4 text-text-1">
              The database is not a black box. Build one — page by page.
            </p>
            <p className="mt-3 max-w-xs text-body-sm text-text-3">
              {TOTAL_LESSON_COUNT} lessons across {TRACKS.length} tracks. Runs 100% in your browser.
              Your progress never leaves <code>localStorage</code>.
            </p>
          </div>

          {/* Learn */}
          <nav aria-label="Learn">
            <h3 className="font-mono text-label uppercase text-text-3">Learn</h3>
            <ul className="mt-4 space-y-2.5">
              {LEARN_LINKS.map((l) => (
                <li key={l.to}>
                  <Link
                    to={l.to}
                    className="text-body-sm text-text-2 transition-colors duration-150 hover:text-accent"
                  >
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          {/* Meta */}
          <nav aria-label="Meta">
            <h3 className="font-mono text-label uppercase text-text-3">Meta</h3>
            <ul className="mt-4 space-y-2.5">
              {META_LINKS.map((l) => (
                <li key={l.label}>
                  <a
                    href={l.href}
                    {...('external' in l ? { target: '_blank', rel: 'noreferrer' } : {})}
                    className="text-body-sm text-text-2 transition-colors duration-150 hover:text-accent"
                  >
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <div className="mt-14 flex flex-col gap-3 border-t border-line pt-6 font-mono text-[11px] tracking-wide text-text-3 sm:flex-row sm:items-center sm:justify-between">
          <span>built static · deployed on the edge · no tracking</span>
          <span>© {new Date().getFullYear()} columnspaces</span>
        </div>
      </div>
    </footer>
  )
}
