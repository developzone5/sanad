// ===================================================
// Topbar - Top Header Bar (inside .page-header)
// Like: Header section in Dashboard.Master
//
// Structure (matches old project exactly):
// .header-wrapper.row.m-0
//   .header-logo-wrapper.col-auto.p-0
//     .logo-wrapper          → Logo (hidden in compact-wrapper by CSS)
//     .toggle-sidebar        → Hamburger icon (hidden in compact-wrapper by CSS)
//   .nav-right.col.pull-right.right-header.p-0.ms-auto
//     ul.nav-menus
//       li.language-switcher → EN / ع buttons
//       li.profile-nav.onhover-dropdown → Avatar + name + dropdown
//
// NOTE: .page-header wrapper is in AppLayout.tsx (not here)
// This component renders the INNER content (.header-wrapper)
// ===================================================

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { AlignCenter, Bell, Settings, LogIn, ChevronDown, HelpCircle } from 'react-feather';

import { communicationsApi } from '@/api/communications';
import { notificationsApi, type NotificationDto } from '@/api/notifications';
import { useCommunicationsCopy } from '@/features/communications/copy';
import useAuthStore from '@/stores/auth-store';
import useProductTourStore from '@/stores/product-tour-store';
import useUIStore from '@/stores/ui-store';
import useUserViewStore from '@/stores/user-view-store';
import { endUserView } from '@/lib/user-view';
import { confirmDiscardUnsavedChanges } from '@/lib/unsaved-changes';
import { getAccessScopeKey } from '@/utils/access-scope-key';
import { authApi } from '@/api/auth';

import topbarLogo from '@/assets/images/logo/logo.png';

function Topbar() {
  const { t } = useTranslation();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const viewSession = useUserViewStore((state) => state.session);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const language = useUIStore((state) => state.language);
  const setLanguage = useUIStore((state) => state.setLanguage);
  const tourController = useProductTourStore((state) => state.controller);
  const tourRunning = useProductTourStore((state) => state.isRunning);
  const tourStarting = useProductTourStore((state) => state.isStarting);
  const startTour = useProductTourStore((state) => state.startTour);
  const stopTour = useProductTourStore((state) => state.stopTour);
  const { copy } = useCommunicationsCopy();
  const navigate = useNavigate();
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const notificationsRef = useRef<HTMLLIElement>(null);
  // The profile menu opens on a tap or a key as well as on hover: a phone has no hover (TUW-244).
  const [profileOpen, setProfileOpen] = useState(false);
  const profileRef = useRef<HTMLLIElement>(null);
  const accessScopeKey = getAccessScopeKey(user);
  const queryClient = useQueryClient();
  const unreadQuery = useQuery({
    queryKey: ['communications', 'unread-count', accessScopeKey],
    queryFn: ({ signal }) => communicationsApi.getUnreadCount(signal),
    enabled: Boolean(user),
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
  // The generic Notification rows (tickets, grades, ...) live behind their own API —
  // the bell surfaces both sources under one badge.
  const systemUnreadQuery = useQuery({
    queryKey: ['notifications', 'unread-count', accessScopeKey],
    queryFn: ({ signal }) => notificationsApi.getUnreadCount(signal),
    enabled: Boolean(user),
    staleTime: 30 * 1000,
    refetchInterval: 60 * 1000,
  });
  const unreadCount = Math.max(unreadQuery.data?.unreadCount ?? 0, 0)
    + Math.max(systemUnreadQuery.data?.unreadCount ?? 0, 0);
  const numberFormatter = new Intl.NumberFormat(language === 'ar' ? 'ar-SA' : 'en-US');
  const formattedUnreadCount = numberFormatter.format(unreadCount);
  const notificationStatus = unreadQuery.isError
    ? copy.bellError
    : unreadCount > 0
      ? copy.unreadCount(formattedUnreadCount)
      : copy.noUnread;
  const badgeCount = unreadCount > 99 ? `${numberFormatter.format(99)}+` : formattedUnreadCount;
  const notificationsQuery = useQuery({
    queryKey: ['communications', 'unread-feed', accessScopeKey],
    queryFn: ({ signal }) => communicationsApi.getFeed({ page: 1, pageSize: 5, unreadOnly: true }, signal),
    enabled: Boolean(user) && notificationsOpen,
    staleTime: 30 * 1000,
  });
  const systemFeedQuery = useQuery({
    queryKey: ['notifications', 'unread-feed', accessScopeKey],
    queryFn: ({ signal }) => notificationsApi.getAll({ unreadOnly: true, page: 1, pageSize: 5 }, signal),
    enabled: Boolean(user) && notificationsOpen,
    staleTime: 30 * 1000,
  });
  const systemItems = systemFeedQuery.data?.items ?? [];

  // Notification rows persist their text in the language they were WRITTEN in; the bell
  // rebuilds ticket items from the language-neutral `type` + ticket number so the panel
  // always reads in the viewer's current language. Unknown types fall back to the raw title.
  const systemItemTitle = (item: NotificationDto) => {
    const num = item.title.match(/TKT-\d+-\d+/)?.[0] ?? '';
    switch (item.type) {
      case 'TICKET_CREATED': return t('tickets.notifCreated', { num });
      case 'TICKET_REPLY': return t('tickets.notifReply', { num });
      case 'TICKET_ASSIGNED': return t('tickets.notifAssigned', { num });
      case 'TICKET_STATUS': return t('tickets.notifStatus', { num });
      default: return item.title;
    }
  };
  // CREATED/ASSIGNED messages carry the user-typed ticket title (worth showing as-is);
  // the other ticket messages are canned text in the writer's language — skip those.
  const systemItemMessage = (item: NotificationDto) =>
    item.type === 'TICKET_CREATED' || item.type === 'TICKET_ASSIGNED' || !item.type.startsWith('TICKET')
      ? item.message
      : null;

  const openSystemNotification = (id: number, actionUrl?: string | null) => {
    setNotificationsOpen(false);
    // Mark read in the background; the badge refreshes either way.
    notificationsApi.markRead(id).finally(() => {
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-count'] });
      void queryClient.invalidateQueries({ queryKey: ['notifications', 'unread-feed'] });
    });
    // Server-built relative paths only — anything else is ignored, never followed.
    if (actionUrl && actionUrl.startsWith('/') && !actionUrl.startsWith('//')) navigate(actionUrl);
  };

  useEffect(() => {
    if (!notificationsOpen) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (notificationsRef.current && !notificationsRef.current.contains(event.target as Node)) setNotificationsOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNotificationsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [notificationsOpen]);

  useEffect(() => {
    if (!profileOpen) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(event.target as Node)) setProfileOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setProfileOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [profileOpen]);

  // Sign Out handler
  const handleSignOut = async () => {
    // In an admin's read-only user-view tab this item is "End view": it ends the view and never
    // the realm session, which is the admin's own and shared with their other tab.
    if (viewSession) {
      await endUserView(viewSession.sessionId);
      return;
    }
    // A page holding unsaved edits gets to object first. It cannot object on its own:
    // logout() below clears the auth store, ProtectedRoute immediately swaps the tree for
    // <Navigate to="/login" />, and the page's own useBlocker unmounts with it — so the
    // edits would vanish without a word. See lib/unsaved-changes.ts.
    // A guard that throws must not strand someone signed in: on a shared computer a broken
    // prompt is a reason to sign out, not a reason to silently refuse. Only a deliberate
    // "stay" keeps the session.
    let mayLeave = true;
    try {
      mayLeave = await confirmDiscardUnsavedChanges();
    } catch {
      mayLeave = true;
    }
    if (!mayLeave) return;
    // Clear local UI state, then sign out. Under SSO, authApi.logout() redirects the browser to
    // Keycloak to end the realm session too (so the next person on a shared computer is not
    // silently signed back in); it does not return here. Under password login it clears the cookie.
    logout();
    await authApi.logout();
    navigate('/login', { replace: true });
  };

  const displayRole = user?.roles[0] || 'User';
  const tourActive = tourRunning || tourStarting;
  const tourControlLabel = t(
    tourActive ? 'tourControls.stopPageTour' : 'tourControls.startPageTour',
  );

  return (
    <div className="header-wrapper row m-0">

      {/* === Left Side: Logo + Toggle === */}
      {/* In compact-wrapper mode, CSS hides these (logo shows in sidebar instead) */}
      <div className="header-logo-wrapper col-auto p-0">
        <div className="logo-wrapper">
          <a href="/dashboard" aria-label="EduQuest - Go to dashboard">
            <img className="img-fluid for-light" src={topbarLogo} width="180" alt="Tuwaiq Academy" />
            {/* Dark mode shows the same artwork whited-out via CSS — the old
                logo_dark.png asset was a wrong mark and was removed. */}
            <img
              className="img-fluid for-dark"
              src={topbarLogo}
              width="180"
              alt="Tuwaiq Academy"
              style={{ filter: 'brightness(0) invert(1)' }}
            />
          </a>
        </div>
        <div className="toggle-sidebar" onClick={toggleSidebar}>
          <AlignCenter className="status_toggle middle sidebar-toggle" size={20} />
        </div>
      </div>

      {/* === Right Side: Language + Profile === */}
      <div className="nav-right col-xxl-7 col-xl-6 col-md-7 col-8 pull-right right-header p-0 ms-auto">
        <ul className="nav-menus">

          {tourController && (
            <li className="product-tour-control">
              <button
                type="button"
                className={`topbar-action-btn product-tour-toggle${tourActive ? ' is-active' : ''}`}
                data-tour-control="page"
                aria-label={tourControlLabel}
                title={tourControlLabel}
                aria-pressed={tourActive}
                onClick={() => {
                  if (tourActive) {
                    stopTour();
                  } else {
                    void startTour(tourController.id);
                  }
                }}
              >
                {/* Always the help glyph: while a tour runs the topbar is dimmed and
                    inert under the overlay, so an X here would offer an exit that
                    cannot be clicked. Exiting lives in the popover's Skip control. */}
                <HelpCircle size={20} aria-hidden="true" />
              </button>
            </li>
          )}

          <li className={`communications-notification${notificationsOpen ? ' is-open' : ''}`} ref={notificationsRef}>
            <button
              type="button"
              className="topbar-action-btn comm-topbar-bell"
              aria-label={`${copy.notificationLabel}: ${notificationStatus}`}
              title={notificationStatus}
              aria-expanded={notificationsOpen}
              aria-controls="communications-notification-panel"
              onClick={() => setNotificationsOpen(open => !open)}
            >
              <Bell size={20} aria-hidden="true" />
              {unreadCount > 0 && <span className="comm-topbar-badge" aria-hidden="true">{badgeCount}</span>}
            </button>
            {notificationsOpen && (
              <div id="communications-notification-panel" className="comm-notification-panel" role="dialog" aria-label={copy.notificationLabel}>
                <div className="comm-notification-panel-header">
                  <strong>{copy.notifications}</strong>
                  <span>{unreadCount > 0 ? copy.unreadCount(formattedUnreadCount) : copy.noUnread}</span>
                </div>
                {notificationsQuery.isLoading || systemFeedQuery.isLoading ? (
                  <p className="comm-notification-state">{copy.loading}</p>
                ) : notificationsQuery.isError && systemFeedQuery.isError ? (
                  <p className="comm-notification-state">{copy.bellError}</p>
                ) : systemItems.length || notificationsQuery.data?.items.length ? (
                  <div className="comm-notification-list">
                    {systemItems.map(item => (
                      <button
                        type="button"
                        className="comm-notification-item"
                        key={`system-${item.id}`}
                        onClick={() => openSystemNotification(item.id, item.actionUrl)}
                      >
                        <span className="comm-notification-item-kind">
                          {item.type.startsWith('TICKET') ? t('tickets.title') : t('notificationsBell.general')}
                        </span>
                        <strong>{systemItemTitle(item)}</strong>
                        {systemItemMessage(item) && <span>{systemItemMessage(item)}</span>}
                      </button>
                    ))}
                    {(notificationsQuery.data?.items ?? []).map(item => (
                      <button
                        type="button"
                        className="comm-notification-item"
                        key={item.id}
                        onClick={() => { setNotificationsOpen(false); navigate(`/communications/${item.id}`); }}
                      >
                        <span className="comm-notification-item-kind">{copy.kinds[item.kind]}</span>
                        <strong>{item.title}</strong>
                        {item.summary && <span>{item.summary}</span>}
                      </button>
                    ))}
                  </div>
                ) : <p className="comm-notification-state">{copy.noUnread}</p>}
              </div>
            )}
            <span className="visually-hidden" role="status" aria-live="polite">{notificationStatus}</span>
          </li>

          {/* Language Switcher */}
          <li className="language-switcher">
            <button
              type="button"
              className={`lang-btn ${language === 'en' ? 'active' : ''}`}
              onClick={() => setLanguage('en')}
            >
              EN
            </button>
            <button
              type="button"
              className={`lang-btn ${language === 'ar' ? 'active' : ''}`}
              onClick={() => setLanguage('ar')}
            >
              ع
            </button>
          </li>

          {/* Profile Dropdown — CSS hover on a mouse (onhover-dropdown → onhover-show-div), and the
              name block is a button: a tap or a key sets .is-open, since a phone has no hover (TUW-244). */}
          {/* The CSS handles show/hide via opacity + transform animation */}
          <li className={`profile-nav onhover-dropdown pe-0 py-0${profileOpen ? ' is-open' : ''}`} ref={profileRef}>
            <div
              className="d-flex profile-media"
              role="button"
              tabIndex={0}
              aria-haspopup="menu"
              aria-expanded={profileOpen}
              onClick={() => setProfileOpen(open => !open)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  setProfileOpen(open => !open);
                }
              }}
            >
              {/* Avatar: the uploaded picture, or the first letter of the name as a fallback */}
              {user?.profilePictureUrl ? (
                <img
                  src={user.profilePictureUrl}
                  alt=""
                  style={{
                    width: '45px',
                    height: '45px',
                    borderRadius: '10px',
                    objectFit: 'cover',
                    flexShrink: 0,
                  }}
                />
              ) : (
                <div
                  className="b-r-10 d-flex align-items-center justify-content-center"
                  style={{
                    width: '45px',
                    height: '45px',
                    backgroundColor: '#4f29b7',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '16px',
                    borderRadius: '10px',
                    flexShrink: 0,
                  }}
                >
                  {user?.fullName?.charAt(0).toUpperCase() || 'U'}
                </div>
              )}
              <div className="flex-grow-1 ms-2">
                <span>{user?.fullName || 'User'}</span>
                <p className="mb-0">
                  {displayRole} <ChevronDown size={14} className="middle" />
                </p>
              </div>
            </div>

            {/* Dropdown — visible on .onhover-dropdown:hover (mouse) or .profile-nav.is-open (tap, key) */}
            <ul className="profile-dropdown onhover-show-div">
              <li>
                <a href="/settings">
                  <Settings size={16} />
                  <span>{language === 'ar' ? 'الإعدادات' : 'Settings'}</span>
                </a>
              </li>
              <li>
                <a
                  role="button"
                  tabIndex={0}
                  onClick={handleSignOut}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSignOut(); }}
                  style={{ cursor: 'pointer' }}
                >
                  <LogIn size={16} />
                  <span>
                    {viewSession
                      ? t('tickets.userViewEnd')
                      : language === 'ar' ? 'تسجيل الخروج' : 'Sign Out'}
                  </span>
                </a>
              </li>
            </ul>
          </li>

        </ul>
      </div>

    </div>
  );
}

export default Topbar;
