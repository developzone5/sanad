import type { UserInfoDto } from '@/types/auth';
import { getUserViewSession } from '@/stores/user-view-store';

type AccessScopeUser = Pick<UserInfoDto, 'id' | 'roles' | 'campusId'>;

// Query caches must follow the authenticated data scope. The server remains the
// authority; this key only prevents a warm cache from being shown to another
// user, role set, or campus while the new request is in flight.
export function getAccessScopeKey(user: AccessScopeUser | null | undefined): string {
  if (!user) return 'unknown';
  // An admin's read-only user view is its own scope: two consecutive views of the same member
  // in one tab must never share a warm cache either.
  const view = getUserViewSession();
  const viewSuffix = view ? `:uv${view.sessionId}` : '';
  return `${user.id}:${[...user.roles].sort().join(',')}:${user.campusId ?? 'none'}${viewSuffix}`;
}
