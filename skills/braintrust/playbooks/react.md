# Playbook — React (SPA)

Load when the stack line names React. For Next.js, load [nextjs.md](nextjs.md) as well. Tags as in [dotnet.md](dotnet.md).

- [STATE] Each value has one home: the URL for the shareable view (filters, tabs, page), the server cache for server data, component state for drafts and open menus. Never copy server data into `useState` and then edit both copies.
- [STATE] A filter that replaces another removes the other key in the same URL write. Clearing it must not bring the older value back. Write the URL once per event, with the updater form.
- [STATE] Old and hand-made links: unknown values read as the default; Back, Forward and refresh land on the same view.
- [STATE] A shared setter, hook or helper changed for one path changes every caller. Check each caller in the size check's `callers:` line.
- [STATE] Query keys hold every input of the request plus the user or tenant scope. Invalidate after mutations. Clear the cache on logout, so the next user sees none of it.
- [STATE] Async results: after `await`, the state read in the closure may be old (use the updater form or a ref). A result that arrives after the user left the page must not navigate or set state (abort signal or a mounted flag).
- [STATE] Pending actions are disabled against double clicks. Optimistic updates roll back on error. Timers and subscriptions are cleaned up.
- [STATE] Lists use stable ids as keys, never the index, when items reorder.
- [SEC] Role checks in the UI are convenience; the server enforces them. Every build-time variable (`VITE_*`, `NEXT_PUBLIC_*`) is public. No user text through `dangerouslySetInnerHTML`.
- [PRODUCT] Every screen has loading, empty, error and slow states, in every locale it serves, right-to-left included, and works with the keyboard.
- [TEST] Testing Library by role and name. Assert the final URL and the request sent, not only the highlight. Test sequences (set A → set B → clear B, twice, after reload). Use fake timers for debounce.
