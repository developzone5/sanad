// ===================================================
// Role Helper Utilities
// Like: helper methods in a RoleHelper.cs utility class
//
// These functions help with role-based logic:
// - Which dashboard to show after login?
// - Does the user have a specific role?
// ===================================================

import type { UserRole } from '@/types/auth';

// getDashboardPath() — where to redirect after login
// Each role goes to the same /dashboard page, but the dashboard
// component will show different widgets based on the role
//
// Like:
//   switch (user.Role) {
//       case "Admin": return RedirectToAction("Home", "Admin");
//       case "Student": return RedirectToAction("Home", "Student");
//   }
export function getDashboardPath(): string {
  return '/dashboard';
}

// hasRole() — check if a roles array contains a specific role
// Used in components to show/hide elements based on role
//
// Usage: if (hasRole(user.roles, 'Admin')) { ... }
//
// Like: User.IsInRole("Admin") in .NET
export function hasRole(roles: string[], role: UserRole): boolean {
  return roles.includes(role);
}

// hasAnyRole() — check if user has ANY of the specified roles
// Useful for features shared by multiple roles
//
// Usage: if (hasAnyRole(user.roles, ['Admin', 'Manager'])) { ... }
//
// Like: [Authorize(Roles = "Admin,Manager")]
export function hasAnyRole(roles: string[], allowedRoles: UserRole[]): boolean {
  return allowedRoles.some((role) => roles.includes(role));
  // .some() = returns true if at least one element matches
  // Like: allowedRoles.Any(r => roles.Contains(r)) in LINQ
}
