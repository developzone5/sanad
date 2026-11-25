import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import Swal from 'sweetalert2';
import { AlertTriangle, ChevronLeft, ChevronRight, Columns, Inbox, LifeBuoy, List as ListIcon, Search } from 'react-feather';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faBarsProgress, faCircleExclamation, faCircleInfo, faEye, faFolderOpen,
  faHourglassHalf, faPlus, faUserCheck,
} from '@fortawesome/free-solid-svg-icons';

import '@/styles/academic-structure.css';
import '@/styles/education-stages.css';
import '@/styles/users-management.css';
import '@/styles/materials.css';
import '@/styles/eq-cards.css';
import '@/styles/tickets.css';

import { ticketsApi } from '@/api/tickets';
import type { TicketDto } from '@/types/tickets';
import useAuthStore from '@/stores/auth-store';
import { openUserViewTab } from '@/lib/user-view';
import { getAccessScopeKey } from '@/utils/access-scope-key';
import { getApiErrorMessage, translateApiError } from '@/utils/api-error';
import usePagination from '@/hooks/use-pagination';
import EqCardMenu from '@/components/shared/EqCardMenu';
import { ticketStatusClass } from '@/pages/tickets/ticket-status';

const TicketFormModal = lazy(() => import('@/components/tickets/TicketFormModal'));

const PAGE_SIZES = [10, 25, 50];

export default function TicketsPage() {
  const { t, i18n } = useTranslation();
  const isAr = i18n.language === 'ar';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore(state => state.user);
  const isAdmin = user?.roles.includes('Admin') ?? false;
  const isManager = user?.roles.includes('Manager') ?? false;
  // Managers get the manage board too — server-pinned to their campus, support-directed
  // tickets excluded server-side.
  const canManage = isAdmin || isManager;
  const accessScopeKey = getAccessScopeKey(user);

  const pagination = usePagination(10);
  const page = Number.isInteger(pagination.page) && pagination.page > 0 ? pagination.page : 1;
  const pageSize = PAGE_SIZES.includes(pagination.pageSize) ? pagination.pageSize : 10;
  const { setPage, setPageSize, setSearch } = pagination;

  const [searchInput, setSearchInput] = useState(pagination.search);
  const [showCreate, setShowCreate] = useState(false);

  // Filters live in the URL (like page/pageSize/search above) so the browser Back button from a
  // ticket's detail page restores them instead of remounting this page back to defaults.
  const [filterParams, setFilterParams] = useSearchParams();
  const statusCode = filterParams.get('status') ?? '';
  const categoryCode = filterParams.get('category') ?? '';
  const priorityCode = filterParams.get('priority') ?? '';
  const assignedToMe = filterParams.get('assignedToMe') === '1';
  const requesterRole = filterParams.get('role') ?? '';
  const view: 'table' | 'kanban' = filterParams.get('view') === 'kanban' ? 'kanban' : 'table';

  // Bundles the filter change and the page=1 reset into one URL write — writing them as two
  // separate setSearchParams calls in the same handler would race (see the page-size note below).
  function setFilterParam(key: string, value: string, resetPage = true) {
    setFilterParams(prev => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value); else next.delete(key);
      if (resetPage) next.set('page', '1');
      return next;
    });
  }
  const setStatusCode = (value: string) => setFilterParam('status', value);
  const setCategoryCode = (value: string) => setFilterParam('category', value);
  const setPriorityCode = (value: string) => setFilterParam('priority', value);
  const setRequesterRole = (value: string) => setFilterParam('role', value);
  const toggleAssignedToMe = () => setFilterParam('assignedToMe', assignedToMe ? '' : '1');
  const setView = (value: 'table' | 'kanban') => setFilterParam('view', value === 'kanban' ? value : '', false);

  // 350ms debounce before the search lands in the URL (and the query key).
  useEffect(() => {
    const handle = setTimeout(() => {
      if (searchInput.trim() !== pagination.search) setSearch(searchInput.trim());
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchInput]);

  const scope = canManage ? 'manage' : 'mine';
  const searchParam = pagination.search || undefined;

  const { data: lookups } = useQuery({
    queryKey: ['tickets', 'lookups'],
    queryFn: ({ signal }) => ticketsApi.getLookups(signal),
    staleTime: 60 * 60 * 1000,
  });

  // The board is not a paged surface: column counts come from the full summary, so the
  // cards must cover the full set too (server caps pageSize at 200).
  const kanbanActive = view === 'kanban' && canManage;
  const effectivePage = kanbanActive ? 1 : page;
  const effectivePageSize = kanbanActive ? 200 : pageSize;

  const listKey = ['tickets', 'list', accessScopeKey, scope, effectivePage, effectivePageSize,
    searchParam ?? null, statusCode || null, categoryCode || null, priorityCode || null,
    assignedToMe, requesterRole || null] as const;
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: listKey,
    queryFn: ({ signal }) => ticketsApi.getAll({
      page: effectivePage, pageSize: effectivePageSize, scope,
      ...(searchParam && { search: searchParam }),
      ...(statusCode && { statusCode }),
      ...(categoryCode && { categoryCode }),
      ...(priorityCode && { priorityCode }),
      ...(assignedToMe && { assignedToMe }),
      ...(requesterRole && { requesterRole }),
    }, signal),
    placeholderData: previous => previous,
    staleTime: 15_000,
  });

  // Clamp the page back into range when filters shrink the result set.
  useEffect(() => {
    const totalPages = data?.totalPages;
    if (totalPages != null && totalPages >= 1 && page > totalPages) setPage(totalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.totalPages]);

  const assignToMeMutation = useMutation({
    mutationFn: (ticketId: number) => ticketsApi.assign(ticketId, Number(user?.id)),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['tickets', 'list'] }),
    onError: (error: unknown) => Swal.fire({
      icon: 'error',
      title: t('tickets.actionError'),
      text: getApiErrorMessage(error) || t('tickets.actionError'),
      confirmButtonColor: '#4f29b7',
    }),
  });

  const summary = data?.summary;
  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const totalCount = data?.totalCount ?? 0;
  const totalPages = data?.totalPages ?? 1;
  const startItem = totalCount === 0 ? 0 : (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, totalCount);
  const pageNumbers = useMemo(() => {
    const pages: number[] = [];
    for (let p = Math.max(1, page - 2); p <= Math.min(totalPages, page + 2); p++) pages.push(p);
    return pages;
  }, [page, totalPages]);

  const lookupLabel = (name: string, nameAr?: string | null) => (isAr && nameAr ? nameAr : name);
  // The pill needs a compact label; the DB name stays the source everywhere else.
  const statusLabel = (row: TicketDto) =>
    row.statusCode === 'WAITING_RESPONSE' && !isAr
      ? t('tickets.statusWaitingShort')
      : lookupLabel(row.statusName, row.statusNameAr);
  const ballLabel = (ball: TicketDto['ballInCourt']) =>
    ball === 'DONE' ? t('tickets.ballDone') : ball === 'REQUESTER' ? t('tickets.ballRequester') : t('tickets.ballStaff');
  const ballClass = (ball: TicketDto['ballInCourt']) =>
    ball === 'DONE' ? 'is-done' : ball === 'REQUESTER' ? 'is-requester' : 'is-staff';
  const formatWhen = (value?: string | null) => {
    if (!value) return '—';
    const text = format(new Date(value), 'dd/MM/yyyy hh:mm a');
    return isAr ? text.replace('AM', 'ص').replace('PM', 'م') : text;
  };

  const kanbanColumns = useMemo(() => {
    const statuses = lookups?.statuses ?? [];
    return statuses.map(status => ({
      status,
      rows: items.filter(row => row.statusCode === status.code),
      count: summary
        ? { OPEN: summary.open, IN_PROGRESS: summary.inProgress, WAITING_RESPONSE: summary.waitingResponse, RESOLVED: summary.resolved, CLOSED: summary.closed }[status.code] ?? 0
        : 0,
    }));
  }, [lookups?.statuses, items, summary]);

  return (
    <div className="stages-page">
      <div className="acad-hero">
        <div className="hero-content">
          <div className="hero-header">
            <div>
              <h1 className="hero-title"><LifeBuoy />{t('tickets.title')}</h1>
              <p className="hero-subtitle">{canManage ? t('tickets.subtitleAdmin') : t('tickets.subtitleMine')}</p>
            </div>
          </div>
          <div className="stats-container">
            <div className="stat-card stat-primary">
              <div className="stat-icon"><FontAwesomeIcon icon={faFolderOpen} /></div>
              <span className="stat-number">{summary?.open ?? '—'}</span>
              <div className="stat-label">{t('tickets.statOpen')}</div>
            </div>
            <div className="stat-card stat-info">
              <div className="stat-icon"><FontAwesomeIcon icon={faBarsProgress} /></div>
              <span className="stat-number">{summary?.inProgress ?? '—'}</span>
              <div className="stat-label">{t('tickets.statInProgress')}</div>
            </div>
            <div className="stat-card stat-warning">
              <div className="stat-icon"><FontAwesomeIcon icon={faHourglassHalf} /></div>
              <span className="stat-number">{summary?.waitingResponse ?? '—'}</span>
              <div className="stat-label">{t('tickets.statWaiting')}</div>
            </div>
            <div className="stat-card stat-danger">
              <div className="stat-icon"><FontAwesomeIcon icon={faCircleExclamation} /></div>
              <span className="stat-number">{summary?.unanswered ?? '—'}</span>
              <div className="stat-label">{t('tickets.statUnanswered')}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="filter-section materials-filter-section">
        <div className="row g-3">
          <div className="col-md-3 materials-filter-field">
            <select className="form-control" aria-label={t('tickets.filterStatus')} value={statusCode} onChange={e => setStatusCode(e.target.value)}>
              <option value="">{t('tickets.filterAllStatuses')}</option>
              {(lookups?.statuses ?? []).map(s => (
                <option key={s.code} value={s.code}>{lookupLabel(s.name, s.nameAr)}</option>
              ))}
            </select>
          </div>
          <div className="col-md-3 materials-filter-field">
            <select className="form-control" aria-label={t('tickets.filterCategory')} value={categoryCode} onChange={e => setCategoryCode(e.target.value)}>
              <option value="">{t('tickets.filterAllCategories')}</option>
              {(lookups?.categories ?? []).map(c => (
                <option key={c.code} value={c.code}>{lookupLabel(c.name, c.nameAr)}</option>
              ))}
            </select>
          </div>
          <div className="col-md-3 materials-filter-field">
            <select className="form-control" aria-label={t('tickets.filterPriority')} value={priorityCode} onChange={e => setPriorityCode(e.target.value)}>
              <option value="">{t('tickets.filterAllPriorities')}</option>
              {(lookups?.priorities ?? []).map(p => (
                <option key={p.code} value={p.code}>{lookupLabel(p.name, p.nameAr)}</option>
              ))}
            </select>
          </div>
          {canManage && (
            <div className="col-md-3 materials-filter-field">
              <select className="form-control" aria-label={t('tickets.filterRole')} value={requesterRole} onChange={e => setRequesterRole(e.target.value)}>
                <option value="">{t('tickets.filterAllRoles')}</option>
                {['Student', 'Teacher', 'Manager', 'Parent', 'Admin'].map(role => (
                  <option key={role} value={role}>{t(`tickets.role${role}`)}</option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <div className="acad-table-card">
        <div className="acad-table-header">
          <h5>{canManage ? t('tickets.tableTitleAdmin') : t('tickets.tableTitleMine')}</h5>
          <div className="acad-table-header-actions tk-header-actions">
            {canManage && (
              <>
                <button
                  type="button"
                  className={`tk-action-btn ${assignedToMe ? 'is-primary' : ''}`}
                  onClick={() => toggleAssignedToMe()}
                >
                  <FontAwesomeIcon icon={faUserCheck} /> {t('tickets.myQueue')}
                </button>
                <button
                  type="button"
                  className={`tk-action-btn ${view === 'kanban' ? 'is-primary' : ''}`}
                  aria-label={view === 'kanban' ? t('tickets.viewTable') : t('tickets.viewKanban')}
                  onClick={() => setView(view === 'kanban' ? 'table' : 'kanban')}
                >
                  {view === 'kanban' ? <ListIcon size={15} /> : <Columns size={15} />}
                  {view === 'kanban' ? t('tickets.viewTable') : t('tickets.viewKanban')}
                </button>
              </>
            )}
            <div className="table-search-input">
              <Search size={16} />
              <input
                type="text"
                placeholder={t('tickets.searchPlaceholder')}
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                autoComplete="off"
              />
            </div>
            <button type="button" className="header-add-btn" onClick={() => setShowCreate(true)}>
              <FontAwesomeIcon icon={faPlus} /> {t('tickets.newTicket')}
            </button>
          </div>
        </div>

        {view === 'kanban' && canManage && items.length > 0 ? (
          <div className="tk-kanban">
            {kanbanColumns.map(({ status, rows, count }) => (
              <div key={status.code} className="tk-kanban-col">
                <div className="tk-kanban-col-head">
                  <span>{lookupLabel(status.name, status.nameAr)}</span>
                  <span className="tk-kanban-count">{count}</span>
                </div>
                {rows.map(row => (
                  <div
                    key={row.id}
                    className="tk-kanban-card"
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/tickets/${row.id}`)}
                    onKeyDown={e => { if (e.key === 'Enter') navigate(`/tickets/${row.id}`); }}
                  >
                    <div className="tk-kanban-num">{row.number}{row.hasUnread && <span className="tk-unread-dot" />}</div>
                    <div className="tk-kanban-title">{row.title}</div>
                    {row.requesterName && (
                      <div className="tk-kanban-req">
                        {row.requesterName}
                        {row.requesterRole && (
                          <span className={`tk-role-chip is-${row.requesterRole.toLowerCase()}`}>
                            {t(`tickets.role${row.requesterRole}`)}
                          </span>
                        )}
                      </div>
                    )}
                    <div className="tk-kanban-foot">
                      <span className="tk-priority-chip">
                        <span className="tk-priority-dot" style={{ background: row.priorityColor ?? '#9aa3b0' }} />
                        {lookupLabel(row.priorityName, row.priorityNameAr)}
                      </span>
                      {row.assigneeName
                        ? <span>{row.assigneeName}</span>
                        : !row.statusIsFinal && (
                          <button
                            type="button"
                            className="tk-action-btn"
                            disabled={assignToMeMutation.isPending}
                            onClick={e => { e.stopPropagation(); assignToMeMutation.mutate(row.id); }}
                          >
                            {t('tickets.assignToMe')}
                          </button>
                        )}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="acad-table-scroll">
            <table className="acad-table">
              <thead>
                <tr>
                  <th>{t('tickets.colTicket')}</th>
                  {canManage && <th>{t('tickets.colRequester')}</th>}
                  <th>{t('tickets.colPriority')}</th>
                  <th>{t('tickets.colStatus')}</th>
                  {canManage && <th>{t('tickets.colAssignee')}</th>}
                  <th>{t('tickets.colUpdated')}</th>
                  <th aria-label={t('tickets.colActions')} />
                </tr>
              </thead>
              <tbody>
                {isError ? (
                  <tr><td colSpan={canManage ? 7 : 5}>
                    <div className="acad-empty">
                      <AlertTriangle />
                      <h6>{t('tickets.loadError')}</h6>
                      <button type="button" className="btn btn-light acad-empty-action" onClick={() => refetch()}>
                        {t('tickets.retry')}
                      </button>
                    </div>
                  </td></tr>
                ) : isLoading && !data ? (
                  <tr><td colSpan={canManage ? 7 : 5}>
                    <div className="acad-empty"><p>{t('tickets.loading')}</p></div>
                  </td></tr>
                ) : items.length === 0 ? (
                  <tr><td colSpan={canManage ? 7 : 5}>
                    <div className="acad-empty">
                      <Inbox />
                      <h6>{t('tickets.emptyTitle')}</h6>
                      <p>{t('tickets.empty')}</p>
                      <button type="button" className="btn btn-light acad-empty-action" onClick={() => setShowCreate(true)}>
                        <FontAwesomeIcon icon={faPlus} /> {t('tickets.newTicket')}
                      </button>
                    </div>
                  </td></tr>
                ) : items.map(row => (
                  <tr
                    key={row.id}
                    className={row.hasUnread ? 'tk-row-unread' : undefined}
                    style={{ cursor: 'pointer' }}
                    onClick={() => navigate(`/tickets/${row.id}`)}
                  >
                    <td>
                      <div className="tk-cell-ticket">
                        <span className="tk-cell-number">
                          {row.number}
                          {row.hasUnread && <span className="tk-unread-dot" />}
                        </span>
                        <span className="tk-cell-title">{row.title}</span>
                      </div>
                    </td>
                    {canManage && (
                      <td>
                        <div className="tk-cell-ticket">
                          <span>{row.requesterName ?? '—'}</span>
                          {row.requesterRole && (
                            <span className={`tk-role-chip is-${row.requesterRole.toLowerCase()}`}>
                              {t(`tickets.role${row.requesterRole}`)}
                            </span>
                          )}
                        </div>
                      </td>
                    )}
                    <td>
                      <span className="tk-priority-chip">
                        <span className="tk-priority-dot" style={{ background: row.priorityColor ?? '#9aa3b0' }} />
                        {lookupLabel(row.priorityName, row.priorityNameAr)}
                      </span>
                    </td>
                    <td>
                      <div className="tk-cell-status">
                        <span className={`status-badge ${ticketStatusClass(row.statusCode)}`}>{statusLabel(row)}</span>
                        {row.ballInCourt !== 'DONE' && (
                          <span className={`tk-ball-chip ${ballClass(row.ballInCourt)}`}>{ballLabel(row.ballInCourt)}</span>
                        )}
                      </div>
                    </td>
                    {canManage && <td>{row.assigneeName ?? '—'}</td>}
                    <td>{formatWhen(row.updatedAt ?? row.createdAt)}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div className="acad-table-actions">
                        <EqCardMenu
                          label={`${t('tickets.moreActions')} — ${row.number}`}
                          items={[
                            {
                              key: 'view',
                              icon: <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" />,
                              label: t('tickets.actionView'),
                              onSelect: () => navigate(`/tickets/${row.id}`),
                            },
                            ...(canManage && !row.statusIsFinal && row.assignedToId !== Number(user?.id) ? [{
                              key: 'assign-me',
                              icon: <FontAwesomeIcon icon={faUserCheck} aria-hidden="true" />,
                              label: t('tickets.assignToMe'),
                              onSelect: () => assignToMeMutation.mutate(row.id),
                            }] : []),
                            // Admin only (Managers must not get it), never for an Admin requester,
                            // never for yourself, and only while the ticket is open — the same
                            // rules the server enforces, pre-applied so the item is not a 404.
                            ...(isAdmin && !row.statusIsFinal && row.requesterRole !== 'Admin' && row.createdBy !== Number(user?.id) ? [{
                              key: 'view-as',
                              icon: <FontAwesomeIcon icon={faEye} aria-hidden="true" />,
                              label: t('tickets.userViewAction'),
                              onSelect: () => void openUserViewTab({
                                userId: row.createdBy,
                                ticketId: row.id,
                                requesterName: row.requesterName,
                                ticketNumber: row.number,
                              }).catch((error: unknown) => Swal.fire({
                                icon: 'error',
                                title: t('tickets.userViewStartFailedTitle'),
                                text: error instanceof Error && error.name === 'UserViewPopupBlockedError'
                                  ? error.message
                                  : translateApiError(error, t('tickets.userViewStartFailedFallback')),
                                confirmButtonColor: '#4f29b7',
                              })),
                            }] : []),
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {totalCount > pageSize && view !== 'kanban' && (
          <div className="acad-pagination">
            <div className="acad-pagination-info">
              {t('tickets.paginationInfo', { start: startItem, end: endItem, total: totalCount })}
            </div>
            <div className="acad-pagination-controls">
              <div className="page-size-select">
                <label htmlFor="tickets-page-size">{t('tickets.paginationShow')}</label>
                {/* Single navigation only: setPageSize already resets page=1 in the same URL write. */}
                <select id="tickets-page-size" value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
                  {PAGE_SIZES.map(size => <option key={size} value={size}>{size}</option>)}
                </select>
              </div>
              <div className="acad-pagination-buttons">
                <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} aria-label={t('tickets.prevPage')}>
                  {isAr ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
                </button>
                {pageNumbers.map(p => (
                  <button
                    type="button"
                    key={p}
                    className={p === page ? 'active' : ''}
                    aria-current={p === page ? 'page' : undefined}
                    onClick={() => setPage(p)}
                  >
                    {p}
                  </button>
                ))}
                <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} aria-label={t('tickets.nextPage')}>
                  {isAr ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {showCreate && (
        <Suspense fallback={null}>
          <TicketFormModal lookups={lookups} onClose={() => setShowCreate(false)} />
        </Suspense>
      )}
    </div>
  );
}
