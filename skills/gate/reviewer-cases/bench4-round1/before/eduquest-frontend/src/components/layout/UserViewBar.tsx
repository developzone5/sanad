// ===================================================
// UserViewBar — the strip that tells the admin whose screens they are looking at
//
// Rendered as the FIRST child of .page-body (AppLayout), so Sidebar and .page-body stay
// adjacent and the theme's `div.sidebar-wrapper.close_icon ~ .page-body` collapse keeps working
// in both directions. Who/until-when come from /auth/me's userView block — the server's word —
// with the tab's own record as the fallback for the names. Purple context surface, no motion:
// colour is for state elsewhere in this product, and a support tool must not tick like an exam.
// ===================================================

import { useTranslation } from 'react-i18next';
import { Eye } from 'react-feather';
import { endUserView } from '@/lib/user-view';
import useAuthStore from '@/stores/auth-store';
import useUserViewStore from '@/stores/user-view-store';

function roleChipClass(role: string | undefined): string {
  switch (role) {
    case 'Student': return 'is-student';
    case 'Teacher': return 'is-teacher';
    case 'Manager': return 'is-manager';
    case 'Parent': return 'is-parent';
    default: return 'is-admin';
  }
}

function UserViewBar() {
  const { t, i18n } = useTranslation();
  const session = useUserViewStore((s) => s.session);
  const user = useAuthStore((s) => s.user);

  if (!session || !user) return null;

  const info = user.userView;
  const name = user.fullName || session.target.fullName;
  const ticketNumber = info?.ticketNumber ?? session.ticket.number;
  const role = user.roles[0];
  const until = new Intl.DateTimeFormat(i18n.language === 'ar' ? 'ar-SA' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(info?.expiresAt ?? session.expiresAt));

  return (
    <div className="uv-bar" role="status" aria-live="polite">
      <span className="uv-bar-icon" aria-hidden="true"><Eye size={16} /></span>
      <span className="uv-bar-label">{t('tickets.userViewBar')}</span>
      <strong className="uv-bar-name" dir="auto">{name}</strong>
      {role && (
        <span className={`uv-bar-role ${roleChipClass(role)}`}>
          {t(`tickets.role${role}`, { defaultValue: role })}
        </span>
      )}
      <span className="uv-bar-meta">{t('tickets.userViewTicket', { num: ticketNumber })}</span>
      <span className="uv-bar-meta">{t('tickets.userViewUntil', { time: until })}</span>
      <button
        type="button"
        className="uv-bar-end"
        onClick={() => void endUserView(info?.sessionId ?? session.sessionId)}
      >
        {t('tickets.userViewEnd')}
      </button>
      <span className="uv-bar-sr">{t('tickets.userViewSr', { name })}</span>
    </div>
  );
}

export default UserViewBar;
