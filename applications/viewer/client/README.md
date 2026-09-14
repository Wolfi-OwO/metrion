# viewer/client

The product frontend: a landing page, a dashboard, a project's metrics view,
its status/dependencies/thresholds screen and its settings screen, served by
`applications/viewer` (`static-frontend.ts`) in production and by Vite's dev
server (proxying `/api` to `:8080`) locally.

## Router

`react-router-dom` v7, declarative mode (`<BrowserRouter>` /
`<Routes>`/`<Route>` in `src/main.tsx`), not the data-router / loader API.

- **Why a router at all now.** The single-screen app this replaces had
  exactly one thing to look at, so a route would have been a second way to
  express state a `useState` pair already held - that reasoning is gone the
  moment there are five screens with distinct URLs worth linking to,
  bookmarking and refreshing: landing, dashboard, a project's metrics, its
  settings, not-found.
- **Why `react-router-dom` over hand-rolling one.** It is a bundled
  dependency, not a runtime fetch - nothing about "no third-party browser
  request" is affected by adding it, the same way adding `recharts` earlier
  was not. A hand-rolled router would need to reinvent `<Link>`,
  `useParams`, `useOutletContext` and back/forward handling for no benefit
  over a library that already gets all four right.
- **Why declarative mode, not loaders.** Every existing data hook
  (`use-loader.ts`, `use-series.ts`) already owns its own fetch, abort and
  retry logic, including the cold-start "waking" affordance the brief
  requires preserved exactly. Router loaders are a second, competing way to
  fetch data; adopting them would mean rewriting hooks that did not need to
  change, for a screen count (five) that does not need it.
- **Why `<Route element={<App />}>` as a layout route.** `App.tsx` owns the
  one `GET /api/v1/me` check every screen needs and the footer every screen
  shares (including error and not-found states), and hands the auth result
  down to routed children via `<Outlet context={auth} />` /
  `useOutletContext`. One request per page load, not one per screen; no
  bespoke `AuthContext` provider, since the router already gives this for
  free between a layout route and its children.

## Screens (`src/routes/`)

| Route                           | Component              | Who sees it                                                                                                                |
| ------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/`                             | `root.tsx`             | Landing (signed out) or dashboard (signed in) - one URL, two screens, decided by the one auth check `App.tsx` already ran. |
| `/projects/:projectId`          | `project-metrics.tsx`  | A project's charts - the original single-screen app's body, moved here unchanged.                                          |
| `/projects/:projectId/status`   | `project-status.tsx`   | Status per application, the dependency graph, threshold editing, recent transitions.                                       |
| `/projects/:projectId/settings` | `project-settings.tsx` | API key creation, one-time reveal, revocation.                                                                             |
| `*`                             | `not-found.tsx`        | Anything unmatched.                                                                                                        |

`landing.tsx` and `dashboard.tsx` are rendered by `root.tsx`, not registered
as their own `<Route>`, so a bookmark to `/` never needs a redirect.

## Design system

Nothing new was introduced - every screen reuses the tokens, type scale and
component patterns `styles/index.css` and the original chart components
already established, rather than growing a second visual language for the
new screens:

- **Colour, type, spacing.** The existing `--color-*` tokens (all measured
  for WCAG contrast, see the comments in `styles/index.css`), the two
  self-hosted `@fontsource` families, and the existing type scale (mono
  11-15px labels, sans 13-15px body, one 28-34px display size for the
  landing headline - the only place this app has ever needed one). No new
  colour, no new font, no new size was added.
- **Status colour (`--color-status-ok`/`-warning`/`-critical`).** Three new
  named tokens, but no new hex - each aliases an already-vetted series
  colour (`--color-series-4`/`-2`/`-8`) so the two ramps can drift
  independently while sharing one set of measured values. Colour is never
  the only signal for a status: `components/status-badge.tsx` always pairs
  it with a distinct icon silhouette (circle/triangle/diamond) and the word
  itself ("OK"/"Warning"/"Critical"), so the state still reads in a
  greyscale screenshot or under any colour-vision deficiency.
- **Borders and flat surfaces over shadows or cards.** The original app drew
  every boundary with a 1px `border-line`, never a shadow, and grouped
  nothing in a rounded card. The new screens (dashboard's project list,
  settings' key list) follow the same rule: a bordered list with
  `divide-y`, not a grid of cards - the existing house style, applied to
  more screens rather than replaced for them.
- **Landing page.** Deliberately not a centred hero with a gradient and a
  three-icon feature grid. The audience for a metrics tool reads a `curl`
  command faster than a tagline, so the page is an asymmetric, left-aligned
  headline against real dense content: a table of the actual resource kinds
  the picker already offers (`Host` / `Container` / `Request host`, taken
  straight from `resource-picker.tsx`'s own `KIND_LABELS`), and a real,
  copy-pasteable request against the documented ingest schema - not an
  illustration, not an invented stat.
- **Forms.** One pattern, used for both the project-name field and the API
  key flow: validate on blur, re-validate on submit, error text next to the
  field naming what to fix (`lib/validate.ts` mirrors the server's own zod
  constraints for this), the input's value is never cleared on error, and a
  disabled/pending button state instead of a spinner.
- **Empty and loading states.** `components/states.tsx`'s `Panel` /
  `Heading` / `Body` / `ActionButton` (already used by the chart screen's
  `EmptyState` and `ErrorState`) are now exported and reused for "no
  projects yet" and "project not found", rather than each new screen
  growing its own version of the same three-part layout.
- **Motion.** No new easing curve or duration was added; the one
  `--ease-instrument` curve and the reduced-motion rule in `styles/index.css`
  already cover everything here, since nothing new animates beyond the
  existing button/link colour transitions and the copy button's "Copied"
  text swap.

## Known limitation: metrics are scoped per session, not per project

`GET /api/v1/resources` and `GET /api/v1/metrics` scope to every project the
calling session owns (`resolveProjectIdsFromSession` in
`applications/viewer/src/middlewares/project-scope.ts` unions across all of
them) - there is no `projectId` query parameter for a screen to send. The
per-project metrics view therefore shows the exact same charts as the
original single-screen app, unchanged, with a project name in its
breadcrumb; it does not yet isolate one project's data from a second
project's. `project-metrics.tsx` states this directly under its toolbar
rather than presenting the two as isolated when they are not. Fixing it is a
backend change (`metrics.schemas.ts`/`metrics-service.ts` accepting and
filtering by project id) outside this task's file list.

## Status, dependencies and thresholds (`project-status.tsx`)

`GET /projects/:id/status` is the single source of truth for the whole
screen - `status-service.ts`'s `ApplicationStatus` (id/key/displayName/
status/effectiveStatus/causedBy/thresholds) is read once and fans out to
four sections on one scrolling page, the same "one long page, not a card
grid" house style the rest of this client already uses:

- **Applications.** Each row's badge is `effectiveStatus`, not `status` - the
  worse of an application's own thresholds and everything it transitively
  depends on. When `causedBy` is set, the text underneath names it and links
  to that application's own row (`#app-{id}`, an anchor every row carries).
- **Dependency graph.** No graph-drawing library - a flat list, one level of
  indentation per application's direct `dependsOn` edges, per the issue's own
  instruction that a dozen nodes do not justify a layout engine.
  `causedBy` already carries the transitive answer regardless of how many
  edges deep it sits, so this view only needs to show what a person would
  actually edit: the direct edges. Editing replaces the whole set via
  `PUT .../dependencies`; a 409 cycle is parsed back into its path
  (`lib/status.ts#cyclePathFromMessage`, since the API sends it as a plain
  `message` string, not a structured field) and rendered as the actual chain
  of application keys, not a generic "Conflict".
- **Thresholds.** `direction` is a real two-option `<fieldset>`, both options
  always visible with their own plain-language sentence
  ("alert when the value goes above/below the threshold") - "below" is one
  click, not a second screen behind "above". Either bound may be empty;
  `lib/validate.ts#thresholdFormErrors` mirrors `thresholdBoundsIssue` in
  `thresholds.schemas.ts` so a bad combination is caught before the request,
  and the server re-validates regardless. `subResource` is schema-supported
  but has no field in this form - see the `ponytail:` comment in
  `threshold-panel.tsx` for why and what preserves it on edit.
- **Recent transitions.** `GET .../status/events`, newest first, each row
  resolved back to an application name (or "project-wide" for a
  project-level threshold) via the same `applications` array the status
  fetch already returned.
- **Dashboard project card.** `components/project-status-indicator.tsx` folds
  every application's `effectiveStatus` in a project into one badge with
  `worseStatus` (`lib/status.ts`) - one request per project row, in
  parallel; see the `ponytail:` comment on that component for the scale this
  is sized for.
- **Registering an application.** `POST /projects/:id/applications` had no
  client caller before this task and nothing in the rest of the app creates
  one, so the status screen's own empty state ("no applications registered
  yet") includes a minimal key/display-name form rather than being a dead
  end - the empty-state rule this client already follows elsewhere
  (`states.tsx`'s `Panel`) applies here too: never a blank screen with no
  action.

## Also out of scope for this task (stated, not hidden)

- **Listing existing API keys.** `POST /api/v1/projects/:id/keys` and
  `DELETE /api/v1/keys/:id` exist; a `GET` that lists a project's keys does
  not. The settings screen tracks only the keys it creates in its own
  lifetime (in React state, not persisted), and says so - a key from an
  earlier visit still revokes by id, just not from a list this screen can
  show.
- **`defaultResource` on project creation.** `POST /api/v1/projects`
  accepts it, but the create-project form does not expose it: it has no
  effect until a key from that project ingests something, so asking for it
  on the first screen a user sees would ask a question before there is
  anything to answer it against.
- **Sub-resource-scoped thresholds and reverse dependency listing (`dependents`).**
  Both are supported by the API `GET /applications/:id/dependencies` and
  `thresholds.schemas.ts` already return/accept, but the issue's own
  acceptance criteria never asked for either, so neither has a UI - see the
  `ponytail:` comment in `threshold-panel.tsx`.

## Accessibility verification

No Lighthouse (or other headless-browser) tooling was available in this
environment - `mcp__playwright__*` tools are not reachable from here, so the
acceptance criterion was checked by manual review instead of a Lighthouse
run:

- Every interactive element is a real `<a>`, `<button>`, `<input>` or
  `<select>` - none is a `<div>` with a click handler - so keyboard
  reachability and the existing global `:focus-visible` rule
  (`styles/index.css`) cover all of them, including the ones added here.
- Every form field has a `<label htmlFor>`; every inline error is
  `role="alert"` and linked with `aria-describedby`; `aria-invalid` is set
  from the same validation state that renders the message, so the two can
  never disagree.
- Every async action's pending/disabled state is expressed on the control
  itself (`disabled`, its own label text changing to "Creating…" /
  "Revoking…" / "Signing out…"), not colour alone.
- The one-time secret uses `aria-label` on its `readOnly` input and the copy
  control's "Copied" feedback is in an `aria-live="polite"` region.
- Colour: every token used is one already measured against WCAG 2.1 AA in
  `styles/index.css`'s own comments (4.5:1 minimum); no new colour was
  introduced by this task. The three new status tokens were re-measured
  against every surface a badge can actually sit on (`bg-950`/`bg-900`/
  `bg-800` - this app has no light theme, `color-scheme: dark` is
  hard-coded, so "light and dark surfaces" narrows to the dark surfaces that
  exist) with a small relative-luminance script, not eyeballed: ok 7.45 /
  6.81 / 5.99 : 1, warning 7.50 / 6.85 / 6.03 : 1, critical 5.65 / 5.16 /
  4.54 : 1 - every one clears the 4.5:1 floor. Status is never carried by
  colour alone regardless: `StatusIcon` gives each state its own silhouette
  (filled circle / triangle / diamond) and `StatusBadge` always renders the
  word next to it, which is what makes the three states distinguishable in
  a greyscale screenshot even though two of the three hues measure close in
  luminance (0.363/0.366/0.263) - shape and text carry that job, not tone.
- `npm run build --workspace=applications/viewer/client` was run and its
  output inspected; no console warnings from React or the build about
  invalid ARIA, duplicate ids or similar were produced. `npm test` (18
  cases, including the new threshold-direction-symmetry and cycle-path-
  parsing tests) passes.

This is a substitute for, not equivalent to, an automated Lighthouse run -
if `playwright`/Lighthouse tooling becomes reachable from an agent session,
re-running the audit against the real rendered pages is worth doing before
this ships.
