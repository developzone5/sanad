import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import Swal from 'sweetalert2';
import { ArrowLeft, ArrowRight, Bell, BellOff, Download, ExternalLink, Paperclip, Search, Send, Star, X } from 'react-feather';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCheck, faClockRotateLeft, faEye, faFileLines, faListUl, faLock,
  faPaperclip, faRotateLeft, faTicket, faUserCheck,
} from '@fortawesome/free-solid-svg-icons';

import '@/styles/academic-structure.css';
import '@/styles/education-stages.css';
import '@/styles/users-management.css';
import '@/styles/materials.css';
import '@/styles/eq-cards.css';
import '@/styles/tickets.css';

import { ticketsApi } from '@/api/tickets';
import { usersApi } from '@/api/users';
import useAuthStore from '@/stores/auth-store';
import { openUserViewTab } from '@/lib/user-view';
import { getAccessScopeKey } from '@/utils/access-scope-key';
import { getApiErrorMessage, translateApiError } from '@/utils/api-error';
import { isOwnPresignedUrl } from '@/utils/presigned-url';
import FilePreview from '@/components/materials/FilePreview';
import { ticketStatusClass } from '@/pages/tickets/ticket-status';
import type { TicketAttachmentDto } from '@/types/tickets';

const BRAND = '#4f29b7';

export default function TicketDetailPage() {
  const { t, i18n } = useTranslation();
  const isAr = i18n.language === 'ar';
  const navigate = useNavigate();
  const params = useParams();
  const ticketId = Number(params.id);
  const queryClient = useQueryClient();
  const user = useAuthStore(state => state.user);
  const userId = Number(user?.id);
  const isAdmin = user?.roles.includes('Admin') ?? false;
  const isManager = user?.roles.includes('Manager') ?? false;
  const isTeacher = user?.roles.includes('Teacher') ?? false;
  const accessScopeKey = getAccessScopeKey(user);
  const lookupLabel = useCallback(
    (name: string, nameAr?: string | null) => (isAr && nameAr ? nameAr : name),
    [isAr],
  );

  const [previewAttachment, setPreviewAttachment] = useState<TicketAttachmentDto | null>(null);
  // Which attachment URL failed to render; the URL, not a flag, so the next attachment still previews.
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null);
  const [commentBody, setCommentBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);
  const [markWaiting, setMarkWaiting] = useState(false);
  const [showRating, setShowRating] = useState(false);
  const [rating, setRating] = useState(0);
  const [ratingComment, setRatingComment] = useState('');
  const [showAssign, setShowAssign] = useState(false);
  const [selectedAssignee, setSelectedAssignee] = useState('');
  const [selectedAssigneeName, setSelectedAssigneeName] = useState('');
  // Admin assign filters: the staff catalog is small, so filtering happens client-side.
  // The search lives INSIDE the assignee combobox (house pattern: TopicParentPicker).
  const [assignCampus, setAssignCampus] = useState('all');
  const [assignRole, setAssignRole] = useState('all');
  const [assignSearch, setAssignSearch] = useState('');
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignActive, setAssignActive] = useState(0);
  const assignBoxRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const detailKey = ['tickets', 'detail', ticketId, accessScopeKey] as const;
  const { data: ticket, isLoading, isError, refetch } = useQuery({
    queryKey: detailKey,
    queryFn: ({ signal }) => ticketsApi.getById(ticketId, signal),
    enabled: Number.isInteger(ticketId) && ticketId > 0,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['tickets', 'detail', ticketId] });
    void queryClient.invalidateQueries({ queryKey: ['tickets', 'list'] });
  };
  const actionError = (error: unknown) => Swal.fire({
    icon: 'error',
    title: t('tickets.actionError'),
    text: getApiErrorMessage(error) || t('tickets.actionError'),
    confirmButtonColor: BRAND,
  });

  const commentMutation = useMutation({
    mutationFn: () => ticketsApi.addComment(ticketId, {
      body: commentBody.trim(),
      ...(isInternal && { isInternal }),
      ...(markWaiting && { markWaiting }),
    }),
    onSuccess: () => {
      setCommentBody('');
      setIsInternal(false);
      setMarkWaiting(false);
      invalidate();
    },
    onError: actionError,
  });

  const attachMutation = useMutation({
    mutationFn: (file: File) => ticketsApi.addAttachment(ticketId, file),
    onSuccess: invalidate,
    onError: actionError,
  });

  // The assignable staff catalog. Admin: the full directory merged from the users API (one
  // page each is plenty — staff headcount is small). Manager/Teacher: their server-scoped
  // recipient set (own-campus staff / own school manager) — never the directory. Loaded only
  // when the dialog opens.
  const { data: staffOptions } = useQuery({
    queryKey: ['tickets', 'staff-options', accessScopeKey, isAdmin ? 'directory' : 'scoped'],
    queryFn: async ({ signal }) => {
      if (!isAdmin) {
        const scoped = await ticketsApi.getRecipients(undefined, signal);
        return [...scoped.managers, ...scoped.teachers].map(option => ({
          id: option.id, fullName: option.name, role: option.role,
          campusId: null as number | null, campusName: null as string | null, campusNameAr: null as string | null,
        }));
      }
      const pages = await Promise.all(['Admin', 'Manager', 'Teacher'].map(role =>
        usersApi.getAll({ page: 1, pageSize: 100, role, status: 'Active' }, signal)
          .then(result => result.items.map(item => ({
            id: item.id, fullName: item.fullName, role,
            campusId: item.campusId, campusName: item.campusName, campusNameAr: item.campusNameAr,
          })))));
      return pages.flat();
    },
    enabled: showAssign,
    staleTime: 5 * 60 * 1000,
  });

  // Filter choices derived from the loaded catalog itself — no extra requests.
  const campusChoices = useMemo(() => {
    const seen = new Map<number, { name: string; nameAr?: string | null }>();
    for (const option of staffOptions ?? []) {
      if (option.campusId != null) {
        seen.set(option.campusId, { name: option.campusName ?? String(option.campusId), nameAr: option.campusNameAr });
      }
    }
    return [...seen.entries()].map(([id, campus]) => ({ id, ...campus }));
  }, [staffOptions]);

  const filteredStaff = useMemo(() => {
    const query = assignSearch.trim().toLowerCase();
    return (staffOptions ?? []).filter(option =>
      (assignCampus === 'all' || option.campusId === Number(assignCampus)) &&
      (assignRole === 'all' || option.role === assignRole) &&
      (!query || option.fullName.toLowerCase().includes(query)));
  }, [staffOptions, assignCampus, assignRole, assignSearch]);

  // Combobox rows: the support-queue entry pinned first (unless the search excludes it),
  // then the filtered staff.
  const assignOptions = useMemo(() => {
    const rows = filteredStaff.map(option => ({
      key: String(option.id),
      id: option.id as number | null,
      label: option.fullName,
      sub: `${t(`tickets.role${option.role}`)}${option.campusName ? ` — ${lookupLabel(option.campusName, option.campusNameAr)}` : ''}`,
    }));
    const supportLabel = t('tickets.assignSupportOption');
    const query = assignSearch.trim().toLowerCase();
    return !query || supportLabel.toLowerCase().includes(query)
      ? [{ key: 'support', id: null, label: supportLabel, sub: '' }, ...rows]
      : rows;
  }, [filteredStaff, assignSearch, t, lookupLabel]);

  const chooseAssign = (option: { id: number | null; label: string }) => {
    setSelectedAssignee(option.id == null ? 'support' : String(option.id));
    setSelectedAssigneeName(option.label);
    setAssignSearch('');
    setAssignOpen(false);
    setAssignActive(0);
  };

  useEffect(() => {
    if (!showAssign) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!assignBoxRef.current?.contains(event.target as Node)) setAssignOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showAssign]);

  const assignMutation = useMutation({
    mutationFn: (assigneeId: number | null) => ticketsApi.assign(ticketId, assigneeId),
    onSuccess: result => {
      setShowAssign(false);
      setSelectedAssignee('');
      // Empty response = the transition succeeded but WE no longer see the ticket
      // (a teacher who escalated it away) — back to the list, not a broken detail view.
      if (result === null) {
        void queryClient.invalidateQueries({ queryKey: ['tickets', 'list'] });
        navigate('/tickets');
        return;
      }
      invalidate();
    },
    onError: actionError,
  });
  const resolveMutation = useMutation({
    mutationFn: () => ticketsApi.resolve(ticketId),
    onSuccess: invalidate,
    onError: actionError,
  });
  const closeMutation = useMutation({
    mutationFn: () => ticketsApi.close(ticketId, {
      ...(rating > 0 && { satisfactionRating: rating }),
      ...(ratingComment.trim() && { satisfactionComment: ratingComment.trim() }),
    }),
    onSuccess: () => { setShowRating(false); invalidate(); },
    onError: actionError,
  });
  const reopenMutation = useMutation({
    mutationFn: () => ticketsApi.reopen(ticketId),
    onSuccess: invalidate,
    onError: actionError,
  });
  const watchMutation = useMutation({
    mutationFn: (watching: boolean) => (watching ? ticketsApi.unwatch(ticketId) : ticketsApi.watch(ticketId)),
    onSuccess: invalidate,
    onError: actionError,
  });

  const busy = commentMutation.isPending || attachMutation.isPending || assignMutation.isPending
    || resolveMutation.isPending || closeMutation.isPending || reopenMutation.isPending;

  // Screenshot paste → attachment. The composer is the natural drop point for "paste evidence".
  const handlePaste = (event: React.ClipboardEvent) => {
    if (!ticket?.canComment || attachMutation.isPending) return;
    const item = Array.from(event.clipboardData.items).find(entry => entry.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    attachMutation.mutate(new File([file], `pasted-${Date.now()}.png`, { type: file.type }));
  };

  const formatWhen = (value?: string | null) => {
    if (!value) return '—';
    const text = format(new Date(value), 'dd/MM/yyyy hh:mm a');
    return isAr ? text.replace('AM', 'ص').replace('PM', 'م') : text;
  };
  const formatSize = (bytes: number) =>
    bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

  const timeline = useMemo(() => {
    if (!ticket) return [];
    const entries: Array<{ key: string; label: string; when: string }> = [
      { key: 'created', label: t('tickets.tlCreated'), when: ticket.createdAt },
    ];
    if (ticket.firstResponseAt) entries.push({ key: 'first', label: t('tickets.tlFirstResponse'), when: ticket.firstResponseAt });
    if (ticket.resolvedAt) entries.push({ key: 'resolved', label: t('tickets.tlResolved'), when: ticket.resolvedAt });
    if (ticket.closedAt) entries.push({ key: 'closed', label: t('tickets.tlClosed'), when: ticket.closedAt });
    return entries;
  }, [ticket, t]);

  if (isLoading) {
    return <div className="stages-page"><div className="acad-empty"><p>{t('tickets.loading')}</p></div></div>;
  }
  if (isError || !ticket) {
    return (
      <div className="stages-page">
        <div className="acad-empty">
          <p>{t('tickets.detailNotFound')}</p>
          <button type="button" className="acad-empty-action" onClick={() => (isError ? refetch() : navigate('/tickets'))}>
            {isError ? t('tickets.retry') : t('tickets.backToList')}
          </button>
        </div>
      </div>
    );
  }

  const isRequester = ticket.createdBy === userId;
  const isAssignee = ticket.assignedToId === userId;
  const active = !ticket.statusIsFinal;
  // Admin/Manager reassign freely (server pins the manager to his campus staff); a teacher
  // only ESCALATES a ticket currently assigned to them — up to the manager or the queue.
  const teacherEscalate = isTeacher && !isAdmin && !isManager;
  const canAssign = active && (isAdmin || isManager || (teacherEscalate && isAssignee));
  const canResolve = (isAdmin || isAssignee) && active && ticket.statusCode !== 'RESOLVED';
  const canClose = active && (isAdmin || (isRequester && ticket.statusCode === 'RESOLVED'));
  const canReopen = (ticket.statusCode === 'RESOLVED' || ticket.statusCode === 'CLOSED') && (isAdmin || isRequester);
  const showStaffOptions = ticket.canInternalNote;
  const BackArrow = isAr ? ArrowRight : ArrowLeft;

  const startClose = () => {
    if (isRequester && !isAdmin) { setShowRating(true); return; }
    void Swal.fire({
      title: t('tickets.closeConfirmTitle'),
      text: t('tickets.closeConfirmText'),
      icon: 'warning',
      showCancelButton: true,
      confirmButtonColor: BRAND,
      confirmButtonText: t('tickets.actionClose'),
      cancelButtonText: t('cancel'),
    }).then(result => { if (result.isConfirmed) closeMutation.mutate(); });
  };

  return (
    <div className="stages-page" dir={isAr ? 'rtl' : 'ltr'}>
      <div className="acad-hero">
        <div className="hero-content">
          <Link to="/tickets" className="tk-action-btn" style={{ marginBottom: 12, display: 'inline-flex' }}>
            <BackArrow size={15} /> {t('tickets.backToList')}
          </Link>
          <h1 className="hero-title"><FontAwesomeIcon icon={faTicket} /> {ticket.number}</h1>
          <div className="tk-actions">
            <span className={`status-badge ${ticketStatusClass(ticket.statusCode)}`}>
              {ticket.statusCode === 'WAITING_RESPONSE' && !isAr
                ? t('tickets.statusWaitingShort')
                : lookupLabel(ticket.statusName, ticket.statusNameAr)}
            </span>
            <span className={`tk-ball-chip ${ticket.ballInCourt === 'DONE' ? 'is-done' : ticket.ballInCourt === 'REQUESTER' ? 'is-requester' : 'is-staff'}`}>
              {ticket.ballInCourt === 'DONE' ? t('tickets.ballDone') : ticket.ballInCourt === 'REQUESTER' ? t('tickets.ballRequester') : t('tickets.ballStaff')}
            </span>
            <span className="tk-priority-chip" style={{ color: '#fff' }}>
              <span className="tk-priority-dot" style={{ background: ticket.priorityColor ?? '#9aa3b0' }} />
              {lookupLabel(ticket.priorityName, ticket.priorityNameAr)}
            </span>
          </div>
          <div className="tk-actions" style={{ marginTop: 14 }}>
            {canAssign && (
              <button
                type="button"
                className="tk-action-btn"
                disabled={busy}
                onClick={() => {
                  setSelectedAssignee(ticket.assignedToId ? String(ticket.assignedToId) : '');
                  setSelectedAssigneeName(ticket.assigneeName ?? '');
                  // Start the admin picker on the ticket's own school — the usual target.
                  setAssignCampus(isAdmin ? String(ticket.campusId) : 'all');
                  setAssignRole('all');
                  setAssignSearch('');
                  setAssignOpen(false);
                  setAssignActive(0);
                  setShowAssign(true);
                }}
              >
                <FontAwesomeIcon icon={faUserCheck} /> {teacherEscalate ? t('tickets.actionEscalate') : t('tickets.actionAssign')}
              </button>
            )}
            {canResolve && (
              <button type="button" className="tk-action-btn is-primary" disabled={busy} onClick={() => resolveMutation.mutate()}>
                <FontAwesomeIcon icon={faCheck} /> {t('tickets.actionResolve')}
              </button>
            )}
            {canClose && (
              <button type="button" className="tk-action-btn" disabled={busy} onClick={startClose}>
                <FontAwesomeIcon icon={faLock} /> {t('tickets.actionClose')}
              </button>
            )}
            {canReopen && (
              <button type="button" className="tk-action-btn is-danger" disabled={busy} onClick={() => reopenMutation.mutate()}>
                <FontAwesomeIcon icon={faRotateLeft} /> {t('tickets.actionReopen')}
              </button>
            )}
            {/* Read-only view of the requester's account — where the admin is reading the complaint
                is where they decide to look. Same rules as the list's row menu. */}
            {isAdmin && !isRequester && !ticket.statusIsFinal && ticket.requesterRole !== 'Admin' && (
              <button
                type="button"
                className="tk-action-btn"
                onClick={() => void openUserViewTab({
                  userId: ticket.createdBy,
                  ticketId: ticket.id,
                  requesterName: ticket.requesterName,
                  ticketNumber: ticket.number,
                }).catch((error: unknown) => Swal.fire({
                  icon: 'error',
                  title: t('tickets.userViewStartFailedTitle'),
                  text: error instanceof Error && error.name === 'UserViewPopupBlockedError'
                    ? error.message
                    : translateApiError(error, t('tickets.userViewStartFailedFallback')),
                  confirmButtonColor: BRAND,
                }))}
              >
                <FontAwesomeIcon icon={faEye} /> {t('tickets.userViewAction')}
              </button>
            )}
            {isAdmin && !isRequester && (
              <button type="button" className="tk-action-btn" disabled={watchMutation.isPending} onClick={() => watchMutation.mutate(ticket.isWatching)}>
                {ticket.isWatching ? <BellOff size={15} /> : <Bell size={15} />}
                {ticket.isWatching ? t('tickets.actionUnwatch') : t('tickets.actionWatch')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="tk-detail-shell">
        <div>
          <div className="tk-card">
            <div className="tk-card-title"><FontAwesomeIcon icon={faFileLines} /> {t('tickets.secDescription')}</div>
            <h6 className="tk-detail-title">{ticket.title}</h6>
            <p className="tk-description">{ticket.description}</p>
          </div>

          <div className="tk-card">
            <div className="tk-card-title">
              <FontAwesomeIcon icon={faListUl} /> {t('tickets.secThread', { count: ticket.comments.length })}
            </div>
            {ticket.comments.length === 0 ? (
              <div className="tk-thread-empty">{t('tickets.threadEmpty')}</div>
            ) : (
              <div className="tk-thread">
                {ticket.comments.map(comment => (
                  <div
                    key={comment.id}
                    className={`tk-comment${comment.authorId === userId ? ' is-own' : ''}${comment.isInternal ? ' is-internal' : ''}`}
                  >
                    <div className="tk-comment-head">
                      <span className="tk-comment-author">{comment.authorName}</span>
                      <span>{formatWhen(comment.createdAt)}</span>
                      {comment.isInternal && (
                        <span className="tk-internal-tag"><FontAwesomeIcon icon={faLock} /> {t('tickets.internalNote')}</span>
                      )}
                    </div>
                    <p className="tk-comment-body">{comment.body}</p>
                  </div>
                ))}
              </div>
            )}

            {ticket.canComment && (
              <div className="tk-composer" style={{ marginTop: 16 }}>
                <textarea
                  value={commentBody}
                  onChange={e => setCommentBody(e.target.value)}
                  onPaste={handlePaste}
                  placeholder={t('tickets.composerPlaceholder')}
                  maxLength={3000}
                />
                <div className="tk-composer-meta">
                  <span className="tk-composer-hint">{t('tickets.pasteHint')}</span>
                  <span className="tk-composer-count">{commentBody.length}/3000</span>
                </div>
                <div className="tk-composer-bar">
                  <div className="tk-composer-options">
                    {showStaffOptions && (
                      <>
                        <label className="tk-switch">
                          <input
                            type="checkbox"
                            checked={isInternal}
                            onChange={e => { setIsInternal(e.target.checked); if (e.target.checked) setMarkWaiting(false); }}
                          />
                          <span className="tk-switch-track" aria-hidden="true" />
                          {t('tickets.optionInternal')}
                        </label>
                        <label className="tk-switch">
                          <input
                            type="checkbox"
                            checked={markWaiting}
                            disabled={isInternal}
                            onChange={e => setMarkWaiting(e.target.checked)}
                          />
                          <span className="tk-switch-track" aria-hidden="true" />
                          {t('tickets.optionMarkWaiting')}
                        </label>
                      </>
                    )}
                    <button
                      type="button"
                      className="tk-action-btn"
                      disabled={attachMutation.isPending || ticket.attachments.length >= 5}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Paperclip size={14} /> {attachMutation.isPending ? t('tickets.uploading') : t('tickets.attachFile')}
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      hidden
                      accept=".jpg,.jpeg,.png,.gif,.pdf,.doc,.docx,.zip"
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) attachMutation.mutate(file);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  <button
                    type="button"
                    className="tk-action-btn is-primary"
                    disabled={commentMutation.isPending || commentBody.trim().length === 0}
                    onClick={() => commentMutation.mutate()}
                  >
                    <Send size={14} /> {commentMutation.isPending ? t('tickets.btnSending') : t('tickets.btnSend')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div>
          <div className="tk-card">
            <div className="tk-card-title">{t('tickets.secDetailsAside')}</div>
            <dl className="tk-meta-list">
              <div><dt>{t('tickets.colCategory')}</dt><dd>{lookupLabel(ticket.categoryName, ticket.categoryNameAr)}</dd></div>
              <div><dt>{t('tickets.colCampus')}</dt><dd>{lookupLabel(ticket.campusName ?? '—', ticket.campusNameAr)}</dd></div>
              <div>
                <dt>{t('tickets.colRequester')}</dt>
                <dd>
                  {ticket.requesterName ?? '—'}
                  {ticket.requesterRole && (
                    <span className={`tk-role-chip is-${ticket.requesterRole.toLowerCase()}`} style={{ marginInlineStart: 6 }}>
                      {t(`tickets.role${ticket.requesterRole}`)}
                    </span>
                  )}
                </dd>
              </div>
              <div>
                <dt>{t('tickets.colSentTo')}</dt>
                <dd>
                  {ticket.recipientKind === 'SUPPORT'
                    ? t('tickets.recipientSupport')
                    : t(`tickets.role${ticket.recipientKind === 'TEACHER' ? 'Teacher' : 'Manager'}`)}
                </dd>
              </div>
              <div><dt>{t('tickets.colAssignee')}</dt><dd>{ticket.assigneeName ?? t('tickets.unassigned')}</dd></div>
              <div><dt>{t('tickets.colCreated')}</dt><dd>{formatWhen(ticket.createdAt)}</dd></div>
              {ticket.satisfactionRating != null && (
                <div>
                  <dt>{t('tickets.colRating')}</dt>
                  <dd>{'★'.repeat(ticket.satisfactionRating)}{'☆'.repeat(5 - ticket.satisfactionRating)}</dd>
                </div>
              )}
            </dl>
          </div>

          <div className="tk-card">
            <div className="tk-card-title"><FontAwesomeIcon icon={faPaperclip} /> {t('tickets.secAttachments', { count: ticket.attachments.length })}</div>
            {ticket.attachments.length === 0 ? (
              <div className="tk-thread-empty">{t('tickets.attachmentsEmpty')}</div>
            ) : (
              <div className="tk-attachment-list">
                {ticket.attachments.map(attachment => attachment.url ? (
                  <button
                    key={attachment.id}
                    type="button"
                    className="tk-attachment"
                    onClick={() => setPreviewAttachment(attachment)}
                  >
                    <Paperclip size={14} />
                    <span>{attachment.fileName}</span>
                    <span className="tk-attachment-size">{formatSize(attachment.size)}</span>
                  </button>
                ) : (
                  <span key={attachment.id} className="tk-attachment">
                    <Paperclip size={14} />
                    <span>{attachment.fileName}</span>
                    <span className="tk-attachment-size">{formatSize(attachment.size)}</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="tk-card">
            <div className="tk-card-title"><FontAwesomeIcon icon={faClockRotateLeft} /> {t('tickets.secTimeline')}</div>
            <ul className="tk-timeline">
              {timeline.map(entry => (
                <li key={entry.key}>
                  {entry.label}
                  <span className="tk-timeline-when">{formatWhen(entry.when)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {showAssign && (
        <div className="stages-form-modal-overlay" onClick={() => { if (!assignMutation.isPending) setShowAssign(false); }}>
          <div
            className="stages-form-modal-card"
            role="dialog"
            aria-modal="true"
            aria-label={t('tickets.assignTitle')}
            onClick={e => e.stopPropagation()}
            dir={isAr ? 'rtl' : 'ltr'}
            style={{ maxWidth: 600 }}
          >
            <div className="stages-form-modal-header">
              <h5>{teacherEscalate ? t('tickets.escalateTitle') : t('tickets.assignTitle')}</h5>
              <button className="stages-form-modal-close" onClick={() => setShowAssign(false)} disabled={assignMutation.isPending}>&times;</button>
            </div>
            <div className="stages-form-modal-body">
              {isAdmin && (
                <div className="row g-2" style={{ marginBottom: 10 }}>
                  <div className="col-6">
                    <select
                      className="form-control"
                      aria-label={t('tickets.fieldCampus')}
                      value={assignCampus}
                      onChange={e => setAssignCampus(e.target.value)}
                    >
                      <option value="all">{t('tickets.assignAllCampuses')}</option>
                      {campusChoices.map(campus => (
                        <option key={campus.id} value={campus.id}>{lookupLabel(campus.name, campus.nameAr)}</option>
                      ))}
                    </select>
                  </div>
                  <div className="col-6">
                    <select
                      className="form-control"
                      aria-label={t('tickets.filterRole')}
                      value={assignRole}
                      onChange={e => setAssignRole(e.target.value)}
                    >
                      <option value="all">{t('tickets.assignAllRoles')}</option>
                      {['Admin', 'Manager', 'Teacher'].map(role => (
                        <option key={role} value={role}>{t(`tickets.role${role}`)}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}
              <label className="form-label required">{t('tickets.assignSelectLabel')}</label>
              <div className="tk-assign-picker" ref={assignBoxRef}>
                {selectedAssignee && (
                  <div className="tk-assign-selection" dir="auto">
                    <span>
                      {selectedAssignee === 'support' ? t('tickets.assignSupportOption') : selectedAssigneeName}
                    </span>
                    <button
                      type="button"
                      aria-label={t('tickets.assignClear')}
                      onClick={() => { setSelectedAssignee(''); setSelectedAssigneeName(''); }}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  </div>
                )}
                <div className="tk-assign-combobox">
                  <Search size={15} aria-hidden="true" />
                  <input
                    type="search"
                    role="combobox"
                    aria-expanded={assignOpen}
                    aria-autocomplete="list"
                    autoComplete="off"
                    placeholder={t('tickets.assignSearchPlaceholder')}
                    value={assignSearch}
                    onFocus={() => setAssignOpen(true)}
                    onChange={e => { setAssignSearch(e.target.value); setAssignOpen(true); setAssignActive(0); }}
                    onKeyDown={e => {
                      if (e.key === 'Escape') { setAssignOpen(false); return; }
                      if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setAssignOpen(true);
                        setAssignActive(index => Math.min(index + 1, Math.max(0, assignOptions.length - 1)));
                        return;
                      }
                      if (e.key === 'ArrowUp') { e.preventDefault(); setAssignActive(index => Math.max(0, index - 1)); return; }
                      if (e.key === 'Enter' && assignOpen && assignOptions[assignActive]) {
                        e.preventDefault();
                        chooseAssign(assignOptions[assignActive]);
                      }
                    }}
                  />
                </div>
                {assignOpen && (
                  <div className="tk-assign-popup" role="listbox">
                    {assignOptions.length === 0 ? (
                      <div className="tk-assign-empty">{t('tickets.assignNoMatches')}</div>
                    ) : assignOptions.map((option, index) => (
                      <button
                        type="button"
                        key={option.key}
                        role="option"
                        aria-selected={selectedAssignee === (option.id == null ? 'support' : String(option.id))}
                        className={`tk-assign-option${index === assignActive ? ' is-active' : ''}${option.id == null ? ' is-support' : ''}`}
                        onMouseEnter={() => setAssignActive(index)}
                        onClick={() => chooseAssign(option)}
                      >
                        <span>{option.label}{option.id === userId ? ` — ${t('tickets.assignMe')}` : ''}</span>
                        {option.sub && <span className="tk-assign-sub">{option.sub}</span>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {teacherEscalate && <div className="form-text">{t('tickets.escalateHint')}</div>}
            </div>
            <div className="user-form-modal-footer">
              <button type="button" className="btn-cancel" disabled={assignMutation.isPending} onClick={() => setShowAssign(false)}>{t('cancel')}</button>
              <button
                type="button"
                className="btn btn-primary btn-save"
                disabled={assignMutation.isPending || !selectedAssignee}
                onClick={() => assignMutation.mutate(selectedAssignee === 'support' ? null : Number(selectedAssignee))}
              >
                {assignMutation.isPending
                  ? t('tickets.btnSaving')
                  : teacherEscalate ? t('tickets.actionEscalate') : t('tickets.actionAssign')}
              </button>
            </div>
          </div>
        </div>
      )}

      {showRating && (
        <div className="stages-form-modal-overlay" onClick={() => { if (!closeMutation.isPending) setShowRating(false); }}>
          <div
            className="stages-form-modal-card"
            role="dialog"
            aria-modal="true"
            aria-label={t('tickets.ratingTitle')}
            onClick={e => e.stopPropagation()}
            dir={isAr ? 'rtl' : 'ltr'}
            style={{ maxWidth: 420 }}
          >
            <div className="stages-form-modal-header">
              <h5>{t('tickets.ratingTitle')}</h5>
              <button className="stages-form-modal-close" onClick={() => setShowRating(false)} disabled={closeMutation.isPending}>&times;</button>
            </div>
            <div className="stages-form-modal-body">
              <p style={{ textAlign: 'center', color: '#5b6572', fontSize: '0.88rem' }}>{t('tickets.ratingPrompt')}</p>
              <div className="tk-rating-stars">
                {[1, 2, 3, 4, 5].map(value => (
                  <button
                    type="button"
                    key={value}
                    className={value <= rating ? 'is-active' : ''}
                    aria-label={t('tickets.ratingStar', { value })}
                    onClick={() => setRating(value)}
                  >
                    <Star size={26} fill={value <= rating ? 'currentColor' : 'none'} />
                  </button>
                ))}
              </div>
              <textarea
                className="form-control"
                rows={3}
                maxLength={500}
                placeholder={t('tickets.ratingCommentPlaceholder')}
                value={ratingComment}
                onChange={e => setRatingComment(e.target.value)}
              />
            </div>
            <div className="user-form-modal-footer">
              <button type="button" className="btn-cancel" disabled={closeMutation.isPending} onClick={() => setShowRating(false)}>{t('cancel')}</button>
              <button type="button" className="btn btn-primary btn-save" disabled={closeMutation.isPending} onClick={() => closeMutation.mutate()}>
                {closeMutation.isPending ? t('tickets.btnSaving') : t('tickets.ratingSubmit')}
              </button>
            </div>
          </div>
        </div>
      )}

      {previewAttachment && (
        <div className="stages-form-modal-overlay" onClick={() => setPreviewAttachment(null)}>
          <div
            className="stages-form-modal-card tk-attachment-preview-card"
            role="dialog"
            aria-modal="true"
            aria-label={previewAttachment.fileName}
            onClick={e => e.stopPropagation()}
            dir={isAr ? 'rtl' : 'ltr'}
          >
            <div className="stages-form-modal-header">
              <h5 dir="auto">{previewAttachment.fileName}</h5>
              <button className="stages-form-modal-close" onClick={() => setPreviewAttachment(null)}>&times;</button>
            </div>
            <div className="tk-attachment-preview-body">
              {(() => {
                const { url, mime } = previewAttachment;
                if (!url) return null;
                if (mime.startsWith('image/')) {
                  return <img className="tk-attachment-preview-img" src={url} alt={previewAttachment.fileName} />;
                }
                if (mime.startsWith('video/')) {
                  return <video className="tk-attachment-preview-frame" src={url} controls controlsList="nodownload" preload="metadata" />;
                }
                if (mime.startsWith('audio/')) {
                  return <audio src={url} controls preload="metadata" style={{ inlineSize: '100%' }} />;
                }
                if (mime === 'application/pdf' && isOwnPresignedUrl(url) && failedPreviewUrl !== url) {
                  // Rendered from the fetched bytes, never framed at the bucket URL: an object
                  // stored as application/octet-stream DOWNLOADS instead of rendering.
                  return (
                    <FilePreview
                      url={url}
                      title={previewAttachment.fileName}
                      className="tk-attachment-preview-frame"
                      onUnavailable={() => setFailedPreviewUrl(url)}
                    />
                  );
                }
                return (
                  <div className="tk-attachment-preview-empty">
                    <Paperclip size={28} />
                    <p>{t('tickets.previewUnavailable')}</p>
                  </div>
                );
              })()}
            </div>
            <div className="user-form-modal-footer">
              {previewAttachment.url && (
                <a className="btn btn-light" href={previewAttachment.url} target="_blank" rel="noopener noreferrer">
                  {previewAttachment.mime.startsWith('image/')
                    || previewAttachment.mime.startsWith('video/')
                    || previewAttachment.mime.startsWith('audio/')
                    || previewAttachment.mime === 'application/pdf'
                    ? <><ExternalLink size={14} /> {t('tickets.previewOpenInTab')}</>
                    : <><Download size={14} /> {t('tickets.previewDownload')}</>}
                </a>
              )}
              <button type="button" className="btn-cancel" onClick={() => setPreviewAttachment(null)}>{t('tickets.previewClose')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
