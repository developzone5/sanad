# Playbook — Next.js

Load when the stack line names Next.js, together with [react.md](react.md). Tags as in [dotnet.md](dotnet.md); *(version)* lines depend on the Next.js version in the stack line.

- [SEC] A Server Action is a public HTTP endpoint. Check auth and ownership inside every action, validate its input (for example with zod), and never trust hidden form fields.
- [SEC] Route handlers (`app/**/route.ts`) check auth themselves. Middleware alone is not an auth boundary (a 2025 bypass skipped it with one header): re-check in the handler or action, and keep Next.js patched.
- [SEC] Modules that hold secrets import `server-only`. Every `NEXT_PUBLIC_*` value ships to the browser.
- [SEC] Props passed from a Server Component to a Client Component are sent to the browser: pass only the fields the screen needs.
- [STATE] Caching depends on the version: since Next.js 15, `fetch` and GET route handlers are not cached by default *(version)*. After a mutation, call `revalidatePath` or `revalidateTag`. Never cache user-specific data in a shared cache.
- [STATE] Hooks and `window` exist only in Client Components (`'use client'`). Dates, time zones and random values rendered on server and client must match, or hydration fails.
- [PERF] Fetch in parallel in Server Components, not one await after another. Stream slow parts with `Suspense`. Use `next/image` and `next/font`.
- [DB] Prisma or Drizzle in serverless runtimes: one client per process and a pooled connection URL. No queries inside loops over relations. Keep interactive `$transaction` blocks short.
- [TEST] Playwright for flows that cross server and client. Each Server Action gets unit tests, including anonymous and wrong-owner calls.
