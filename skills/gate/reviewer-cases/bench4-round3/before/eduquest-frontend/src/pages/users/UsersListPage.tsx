// ===================================================
// UsersListPage - User Management List
// Matching EXACTLY: Dashboard/Admin/ManageUsers.aspx
//
// Layout (from old project):
// 1. Hero section (gradient banner with stats + filters inside, NO buttons)
// 2. Table card with Bulk Import button + search + custom HTML table
// 3. Floating Action Button (FAB) opens Add User modal
//
// Modals use createPortal to render at document.body
// (avoids CSS stacking context issues from Cuba theme transforms)
// ===================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import Flatpickr from 'react-flatpickr';
import { useNavigate, useSearchParams } from 'react-router-dom';
import 'flatpickr/dist/flatpickr.min.css';
import {
  Users, UserCheck as UserCheckIcon, BookOpen, Award,
  Shield, ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Inbox,
  Search, User, Phone, CreditCard, MapPin, Calendar, Globe, Clock, AlertTriangle,
  RefreshCw, Download,
} from 'react-feather';
import { LuImport } from 'react-icons/lu';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faEye, faEdit, faKey,
  faPlus, faUserCircle, faShieldAlt, faCog, faMale, faFemale,
  faUserGraduate, faChalkboardTeacher, faUserFriends, faBriefcase,
  faUserShield, faCheckCircle, faPauseCircle, faBan, faGlobe,
  faLock, faUnlock, faPause, faCheck, faTrash, faUsers, faEnvelope, faLink, faLinkSlash,
  faRotate, faPaperPlane,
} from '@fortawesome/free-solid-svg-icons';
import Swal from 'sweetalert2';

import { usersApi, rolesApi, campusesDropdownApi, groupsDropdownApi, parentChildrenApi, bulkImportApi } from '@/api/users';
import type { ParentChildrenDataDto, BulkImportUserRequest, BulkImportJobDto } from '@/api/users';
import EqCardMenu from '@/components/shared/EqCardMenu';
import TeacherMicrosoftAccountModal from '@/components/users/TeacherMicrosoftAccountModal';
import TeacherTeamsBulkInviteModal from '@/components/users/TeacherTeamsBulkInviteModal';
import {
  USERS_TOUR,
  showUsersTour,
  stopUsersTour,
} from '@/features/onboarding/users-tour';
import { staffTourAudience } from '@/features/onboarding/tour-audience';
import { hasSeenTour, markTourSeen } from '@/features/onboarding/tour-progress';
import usePagination from '@/hooks/use-pagination';
import useAuthStore from '@/stores/auth-store';
import useProductTourStore from '@/stores/product-tour-store';
import { getAccessScopeKey } from '@/utils/access-scope-key';
import { campusOptionLabel } from '@/utils/campus-option-label';
import { translateApiError } from '@/utils/api-error';
import { buildUsersWorkbook, riyadhDateString } from '@/utils/users-export';
import {
  PARENT_IMPORT_HEADER, PARENT_IMPORT_SAMPLE, STAFF_IMPORT_HEADER, STAFF_IMPORT_SAMPLE,
  decodeImportText, detectImportFileKind, findImportFileProblem, importWasRefused, isUntouchedImportSample,
} from '@/utils/bulk-import-file';
import { UsersPageSkeleton } from '@/components/ui/Skeleton';
import type { CampusDropdownDto, GroupDropdownDto, RelinkPreviewStatus, RoleDto, UserDto, UserGroupInfoDto } from '@/types/users';

import '@/styles/users-management.css';
import '@/styles/eq-cards.css'; // cross-role kebab menu (EqCardMenu trigger + pop)

type Translate = (key: string, options?: Record<string, unknown>) => string;

// Good enough to decide "is this worth asking the server about yet" — the server validates for real.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Carries an already-translated message to the bulk-import modal, instead of "failed to read".
class ImportFileError extends Error {}

function createUserFormSchema(t: Translate, isEditing: boolean) {
  return z.object({
    // Create mirrors the identity platform's username shape (a nonconforming one would create the
    // user locally and then fail SSO provisioning). Edit keeps the old looser bound so accounts
    // that predate the rule can still be saved untouched.
    username: isEditing
      ? z.string()
          .min(3, t('users.validation.usernameMin'))
          .max(50, t('users.validation.usernameMax'))
      : z.string()
          .min(3, t('users.validation.usernameMin'))
          .max(21, t('users.validation.usernameMax21'))
          .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,20}$/, t('users.validation.usernameFormat')),
    email: z.string().email(t('users.validation.emailInvalid')),
    fullName: z.string()
      .min(2, t('users.validation.fullNameMin'))
      .max(100, t('users.validation.fullNameMax')),
    phone: z.string().regex(/^\+?[0-9][0-9\s-]{6,18}$/, t('users.validation.phoneInvalid')).optional().or(z.literal('')),
    // Required on create since the credential rework (the ID is the duplicate-person check an
    // email can't provide); edit keeps it optional so legacy accounts without one still save.
    nationalId: isEditing
      ? z.string().regex(/^[12][0-9]{9}$/, t('users.validation.nationalIdInvalid')).optional().or(z.literal(''))
      : z.string()
          .min(1, t('users.validation.nationalIdRequired'))
          .regex(/^[12][0-9]{9}$/, t('users.validation.nationalIdInvalid')),
    dateOfBirth: z.string().optional().or(z.literal('')),
    gender: z.string().optional().or(z.literal('')),
    campusId: z.string().optional().or(z.literal('')),
    // One user, one role — Edit included since Round 4. Edit's old min(1) let the modal produce
    // dual-role accounts nothing else in the platform models; the backend now rejects them too.
    roleIds: z.array(z.number()).length(1, t('users.validation.roleRequired')),
    groupIds: z.array(z.number()).optional(),
    status: z.string().optional().or(z.literal('')),
    preferredLanguage: z.string().optional().or(z.literal('')),
    timeZone: z.string().optional().or(z.literal('')),
  });
}

type UserFormData = z.infer<ReturnType<typeof createUserFormSchema>>;

// Mirrors ManagerGrantableRoles in UserService.cs — the roles a Manager may hand out. Hiding the
// rest here only matches the server; it does not enforce anything.
const MANAGER_GRANTABLE_ROLES = ['Student', 'Teacher', 'Parent'];

// The roles whose unified account may be re-pointed at another identity from this screen. These are
// the accounts staff open on someone else's behalf, so a wrong or changed address is routine — a
// student registered under a guardian's inbox, a teacher whose school address was retyped. A
// Manager's own account is re-linkable too, but the action is Admin-only (RequireAdminRole in
// UserService.cs) — a Manager caller is refused server-side regardless of target.
const RELINKABLE_ROLES = ['student', 'parent', 'teacher', 'manager'];

// Admin is deliberately absent: re-linking another admin is a take-over-the-platform move that
// belongs with an identity-provider administrator, not here. The server enforces this too
// (GuardRelinkTargetIsNotAdmin in UserService.cs) — this list only decides what is offered.
function canRelinkRole(role: string, callerIsAdmin: boolean): boolean {
  return callerIsAdmin && RELINKABLE_ROLES.includes(role.toLowerCase());
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// ponytail: invitation UI (COM-721) hidden per request, feature stays wired underneath.
// Flip back to true to restore the checkbox column, selection bar and row-menu action.
const SHOW_SEND_INVITATIONS = false;

function UsersListPage() {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore(state => state.user);
  const currentUserId = currentUser?.id;
  const isAdmin = currentUser?.roles.includes('Admin') ?? false;
  const isManager = currentUser?.roles.includes('Manager') ?? false;
  // Managers create + bulk-import again (2026-08-18 ruling, supersedes Round 4's Admin-only):
  // the server pins them to their own school and the Student/Teacher/Parent roles — the buttons here
  // only mirror that; hiding them for other roles keeps the page honest.
  const canCreateUsers = isAdmin || isManager;
  // A Manager is toured too, through their own cut of the walk: no campus filter, and no Admin/Manager roles to grant.
  // Separate ids keep one role's 'seen' flag off the other (see tour-audience).
  const tourAudience = staffTourAudience(currentUser?.roles);
  const pageTour = tourAudience ? USERS_TOUR[tourAudience] : null;
  const locale = i18n.language === 'ar' ? 'ar-SA-u-ca-gregory' : 'en-US';
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }), [locale]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const {
    page: requestedPage,
    pageSize: requestedPageSize,
    search,
    setPage,
    setPageSize,
    setSearch,
  } = usePagination();
  const navigate = useNavigate();
  const [urlSearchParams, setUrlSearchParams] = useSearchParams();
  const rawPageParam = urlSearchParams.get('page');
  const rawPageSizeParam = urlSearchParams.get('pageSize');
  const rawPage = rawPageParam === null ? requestedPage : Number(rawPageParam);
  const rawPageSize = rawPageSizeParam === null ? requestedPageSize : Number(rawPageSizeParam);
  const pageSize = [10, 15, 25, 50].includes(rawPageSize) ? rawPageSize : 10;
  const maxSafePage = Math.floor(2_147_483_647 / pageSize) + 1;
  const page = Number.isSafeInteger(rawPage) && rawPage > 0
    ? Math.min(rawPage, maxSafePage)
    : 1;

  // The shared hook intentionally stays generic. This page canonicalizes untrusted URL values in
  // one replace-navigation so malformed or overflowing offsets never reach the API.
  useEffect(() => {
    const pageNeedsCanonicalization = rawPageParam !== null && rawPageParam !== String(page);
    const pageSizeNeedsCanonicalization = rawPageSizeParam !== null && rawPageSizeParam !== String(pageSize);
    if (!pageNeedsCanonicalization && !pageSizeNeedsCanonicalization) return;

    setUrlSearchParams(previous => {
      const next = new URLSearchParams(previous);
      if (pageNeedsCanonicalization) next.set('page', String(page));
      if (pageSizeNeedsCanonicalization) next.set('pageSize', String(pageSize));
      return next;
    }, { replace: true });
  }, [page, pageSize, rawPageParam, rawPageSizeParam, setUrlSearchParams]);

  const accessScopeKey = getAccessScopeKey(currentUser);

  // ---- Local filter state ----
  const [filterCampus, setFilterCampus] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterStatus, setFilterStatus] = useState('');

  // ---- Sort state ----
  const [sortColumn, setSortColumn] = useState<string>('');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [debouncedSearch, setDebouncedSearch] = useState(search);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timeoutId);
  }, [search]);

  function handleSort(column: string) {
    if (sortColumn === column) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
    setPage(1);
  }

  // ---- Modal states ----
  const [formModalOpen, setFormModalOpen] = useState(false);
  const [linkChildrenUser, setLinkChildrenUser] = useState<UserDto | null>(null);
  const [linkChildrenData, setLinkChildrenData] = useState<ParentChildrenDataDto | null>(null);
  const [linkChildrenLoading, setLinkChildrenLoading] = useState(false);
  const [selectedLinkedIds, setSelectedLinkedIds] = useState<Set<number>>(new Set());
  const [selectedAvailableIds, setSelectedAvailableIds] = useState<Set<number>>(new Set());
  const [linkedSearch, setLinkedSearch] = useState('');
  const [availableSearch, setAvailableSearch] = useState('');
  const [editingUser, setEditingUser] = useState<UserDto | null>(null);
  const [viewingUser, setViewingUser] = useState<UserDto | null>(null);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkCampusId, setBulkCampusId] = useState('');
  const [bulkRole, setBulkRole] = useState<'Student' | 'Teacher' | 'Parent' | ''>('');
  const [bulkGroupIds, setBulkGroupIds] = useState<number[]>([]);
  const [bulkStatus, setBulkStatus] = useState<'Active' | 'Inactive'>('Active');
  const [bulkFile, setBulkFile] = useState<File | null>(null);
  const [bulkDragActive, setBulkDragActive] = useState(false);
  const [bulkValidationError, setBulkValidationError] = useState<string | null>(null);
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [linkChildrenSaving, setLinkChildrenSaving] = useState(false);
  // ---- Re-link (bind the user to a different Tuwaiq account) ----
  const [relinkUser, setRelinkUser] = useState<UserDto | null>(null);
  const [relinkEmail, setRelinkEmail] = useState('');
  // The address the preview has actually been asked about. Trails the input by a beat so a typed
  // address costs one upstream search, not one per keystroke.
  const [debouncedRelinkEmail, setDebouncedRelinkEmail] = useState('');
  // ---- Microsoft Teams account (guest-teacher onboarding) ----
  const [microsoftAccountUser, setMicrosoftAccountUser] = useState<UserDto | null>(null);
  // Bulk Microsoft Teams invitation dialog (admin only; the server re-checks).
  const [bulkTeamsInviteOpen, setBulkTeamsInviteOpen] = useState(false);
  // ---- Invitation selection (COM-721) ----
  // Ids, not rows: the list refetches under the selection (a background refresh, another admin's
  // edit), and holding whole objects would send a stale name into the confirmation dialog. It is
  // scoped to the visible page on purpose — "select all" across an unseen 4,000-row filter is a
  // send nobody reviewed.
  const [selectedInviteIds, setSelectedInviteIds] = useState<Set<number>>(new Set());
  const linkChildrenRequestId = useRef(0);
  const relinkDialogRef = useRef<HTMLDivElement>(null);
  const formDialogRef = useRef<HTMLDivElement>(null);
  const viewDialogRef = useRef<HTMLDivElement>(null);
  const childrenDialogRef = useRef<HTMLDivElement>(null);
  const bulkDialogRef = useRef<HTMLDivElement>(null);
  const bulkFileInputRef = useRef<HTMLInputElement>(null);
  const selectAllInviteRef = useRef<HTMLInputElement>(null);
  const exportAbortControllerRef = useRef<AbortController | null>(null);

  // A route change/unmount or sign-out changes this key. Abort rather than merely hiding a late
  // download, so a large PII response is not needlessly kept in flight after the user leaves.
  useEffect(() => () => exportAbortControllerRef.current?.abort(), [accessScopeKey]);

  const selectedCampusId = filterCampus ? Number(filterCampus) : undefined;
  const usersQueryKey = [
    'users',
    'list',
    accessScopeKey,
    page,
    pageSize,
    debouncedSearch,
    filterCampus,
    filterRole,
    filterStatus,
    sortColumn,
    sortDirection,
  ] as const;

  // ---- Fetch users ----
  const {
    data,
    isLoading,
    isFetching,
    isError,
    refetch,
  } = useQuery({
    queryKey: usersQueryKey,
    queryFn: ({ signal }) => usersApi.getAll({
      page,
      pageSize,
      search: debouncedSearch || undefined,
      campusId: selectedCampusId,
      role: filterRole || undefined,
      status: filterStatus || undefined,
      sortColumn: sortColumn || undefined,
      sortDirection,
    }, signal),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[2] === accessScopeKey ? previousData : undefined,
  });

  const {
    data: statsData,
    isLoading: statsLoading,
    isFetching: statsFetching,
    isError: statsError,
    refetch: refetchStats,
  } = useQuery({
    queryKey: ['users', 'stats', accessScopeKey, filterCampus, filterRole, filterStatus],
    queryFn: ({ signal }) => usersApi.getStats({
      campusId: selectedCampusId,
      role: filterRole || undefined,
      status: filterStatus || undefined,
    }, signal),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[2] === accessScopeKey ? previousData : undefined,
  });

  // ---- Fetch campuses for filter + form ----
  const {
    data: campuses = [],
    isLoading: campusesLoading,
    isError: campusesError,
    refetch: refetchCampuses,
  } = useQuery({
    queryKey: ['campuses-dropdown', accessScopeKey, 'all-statuses'],
    queryFn: ({ signal }) => campusesDropdownApi.getAll(true, signal),
    // Admins need the campus catalog for the visible filter. A Manager is already pinned to one
    // campus by the API, so defer this request until a create/edit/bulk modal actually needs it.
    enabled: isAdmin || formModalOpen || bulkModalOpen,
    staleTime: 10 * 60 * 1000,
    refetchOnMount: true,
  });

  // ---- Fetch roles for form ----
  const {
    data: roles = [],
    isLoading: rolesLoading,
    isError: rolesError,
    refetch: refetchRoles,
  } = useQuery({
    queryKey: ['roles-dropdown', accessScopeKey],
    queryFn: ({ signal }) => rolesApi.getAll(signal),
    staleTime: 10 * 60 * 1000,
    refetchOnMount: true,
  });

  const manageableRoles = useMemo(
    () => {
      // Applicant is granted by the admission pipeline and removed by promotion-in-place — this
      // page's users become Students (or staff), never Applicants, so it is not offered here.
      // A Manager grants Student/Teacher/Parent (server allowlist) — Parent joined it once a
      // Manager could link children on their own campus; editing re-adds the target's current
      // role below. Admin/Manager stay Admin's to hand out.
      const assignable = roles.filter(role => role.name !== 'Applicant');
      return isAdmin
        ? assignable
        : assignable.filter(role => MANAGER_GRANTABLE_ROLES.includes(role.name));
    },
    [isAdmin, roles],
  );

  // The FILTER list mirrors what each caller's USER list can actually contain. Applicant is
  // dropped for everyone (user ruling, Round 4): pipeline accounts live in the registration
  // queue, not on this page. Managers additionally lose Admin/Manager — their list can never
  // hold a privileged user, so those options only manufacture empty result screens.
  const filterRoleOptions = useMemo(
    () => {
      const visible = roles.filter(role => role.name !== 'Applicant');
      return isAdmin ? visible : visible.filter(role => role.name !== 'Admin' && role.name !== 'Manager');
    },
    [isAdmin, roles],
  );
  const isEditingSelf = Boolean(editingUser && editingUser.id === currentUser?.id);
  const activeCampuses = useMemo(
    () => campuses.filter(campus => campus.isActive),
    [campuses],
  );
  const formCampusOptions = useMemo<CampusDropdownDto[]>(() => {
    const options = [...activeCampuses];
    if (editingUser?.campusId && !options.some(campus => campus.id === editingUser.campusId)) {
      const catalogCampus = campuses.find(campus => campus.id === editingUser.campusId);
      options.push(catalogCampus ?? {
        id: editingUser.campusId,
        name: editingUser.campusName ?? String(editingUser.campusId),
        nameAr: editingUser.campusNameAr,
        organizationId: 0,
        isActive: false,
      });
    }
    return options;
  }, [activeCampuses, campuses, editingUser]);
  const formRoleOptions = useMemo<RoleDto[]>(() => {
    const options = [...manageableRoles];
    if (!editingUser) return options;

    editingUser.roleIds.forEach((roleId, index) => {
      if (!options.some(role => role.id === roleId)) {
        options.push({
          id: roleId,
          name: editingUser.roles[index] ?? String(roleId),
        });
      }
    });
    return options;
  }, [editingUser, manageableRoles]);

  // ===================================================
  // MUTATIONS
  // Membership, filters, sort order, aggregates, and parent counts can all change after a user
  // write. Refetch the authoritative server result instead of inserting a response into a page
  // where it may not belong.
  // ===================================================
  function refreshUserDependencies(): void {
    void queryClient.invalidateQueries({ queryKey: ['users'] });
    void queryClient.invalidateQueries({ queryKey: ['campuses'] });
    void queryClient.invalidateQueries({ queryKey: ['groups'] });
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  }

  function getMutationError(error: unknown, fallbackKey: string): string {
    return translateApiError(error, t(fallbackKey));
  }

  function showSuccess(messageKey: string): void {
    void Swal.fire({
      icon: 'success',
      title: t('users.feedback.successTitle'),
      text: t(messageKey),
      confirmButtonColor: '#4f29b7',
    });
  }

  function showError(error: unknown, messageKey: string): void {
    void Swal.fire({
      icon: 'error',
      title: t('users.feedback.errorTitle'),
      text: getMutationError(error, messageKey),
      confirmButtonColor: '#4f29b7',
    });
  }

  const exportMutation = useMutation({
    mutationFn: async () => {
      // Snapshot the controls at click time, including search before its debounce completes.
      const scope = getAccessScopeKey(useAuthStore.getState().user);
      const arabic = i18n.language.startsWith('ar');
      const labels = {
        sheet: t('users.export.sheet'),
        roleNames: Object.fromEntries(['admin', 'manager', 'teacher', 'student', 'parent']
          .map(role => [role, t(`users.enums.roles.${role}`)])),
      };
      const controller = new AbortController();
      exportAbortControllerRef.current?.abort();
      exportAbortControllerRef.current = controller;
      try {
        const result = await usersApi.export({
          search: search || undefined,
          campusId: selectedCampusId,
          role: filterRole || undefined,
          status: filterStatus || undefined,
          sortColumn: sortColumn || undefined,
          sortDirection,
        }, controller.signal);
        const workbook = await buildUsersWorkbook(result, labels, arabic);
        const XLSX = await import('xlsx');
        // Abort covers navigation/session changes. This guard also covers a scope change while the
        // workbook module is loading or its data is being assembled.
        if (controller.signal.aborted || scope !== getAccessScopeKey(useAuthStore.getState().user)) return;
        XLSX.writeFile(workbook, `Users_${riyadhDateString()}.xlsx`);
      } finally {
        if (exportAbortControllerRef.current === controller) exportAbortControllerRef.current = null;
      }
    },
    onError: error => {
      if ((error as { code?: string }).code === 'ERR_CANCELED') return;
      showError(error, 'users.export.error');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => usersApi.delete(id),
    onSuccess: () => {
      if (data && page > 1 && data.items.length === 1) {
        setPage(page - 1);
      }
      refreshUserDependencies();
      showSuccess('users.feedback.deleteSuccess');
    },
    onError: error => showError(error, 'users.feedback.deleteError'),
  });

  const suspendMutation = useMutation({
    mutationFn: (id: number) => usersApi.suspend(id),
    onSuccess: () => {
      refreshUserDependencies();
      showSuccess('users.feedback.suspendSuccess');
    },
    onError: error => showError(error, 'users.feedback.suspendError'),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: number) => usersApi.reactivate(id),
    onSuccess: () => {
      refreshUserDependencies();
      showSuccess('users.feedback.reactivateSuccess');
    },
    onError: error => showError(error, 'users.feedback.reactivateError'),
  });

  const lockMutation = useMutation({
    mutationFn: (id: number) => usersApi.lock(id),
    onSuccess: () => {
      refreshUserDependencies();
      showSuccess('users.feedback.lockSuccess');
    },
    onError: error => showError(error, 'users.feedback.lockError'),
  });

  const unlockMutation = useMutation({
    mutationFn: (id: number) => usersApi.unlock(id),
    onSuccess: () => {
      refreshUserDependencies();
      showSuccess('users.feedback.unlockSuccess');
    },
    onError: error => showError(error, 'users.feedback.unlockError'),
  });

  const resetPasswordMutation = useMutation({
    mutationFn: (id: number) => usersApi.resetPassword(id),
    onSuccess: response => {
      // A plain "success" here would be a lie worth catching: for a user who signs in through single
      // sign-on, a password that changed only in EduQuest means the one the admin is about to hand
      // over will be refused at the sign-in page, with nothing on screen explaining why.
      if (response?.data?.ssoSynced === false) {
        void Swal.fire({
          icon: 'warning',
          title: t('users.resetPassword.ssoNotSyncedTitle'),
          text: t('users.resetPassword.ssoNotSynced'),
        });
        return;
      }
      showSuccess('users.resetPassword.success');
    },
    onError: (error: unknown) => {
      // 429 = an account email went to this user moments ago; the per-target cooldown refused a
      // second credential rather than flooding their inbox.
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 429) {
        void Swal.fire({ icon: 'info', text: t('users.resetPassword.tooSoon') });
        return;
      }
      showError(error, 'users.resetPassword.error');
    },
  });

  // ---- Send platform invitations (COM-721) ----
  // Always resolves; the server answers 200 with counts even when some recipients were skipped,
  // because "three were on cooldown" must not throw away the answer for the twenty-seven that
  // went out. So the outcome is read from the body, not from the status.
  const sendInvitationsMutation = useMutation({
    mutationFn: (userIds: number[]) => usersApi.sendInvitations(userIds),
    onSuccess: response => {
      const result = response?.data;
      if (!result) return;

      // Cleared only when the whole selection went out. When anything came back on cooldown the
      // dialog says "try again shortly" — dropping the ticks would make that advice mean re-ticking
      // fifty checkboxes by hand, so the rows stay armed and the retry is one click. Re-sending the
      // ones that DID go out is harmless: the per-target cooldown reports them as skipped.
      const skipped = result.skippedTooSoon + result.notFound;
      if (skipped === 0) {
        setSelectedInviteIds(new Set());
        void Swal.fire({
          icon: 'success',
          title: t('users.invitation.success', {
            count: result.sent,
            formattedCount: numberFormatter.format(result.sent),
          }),
          confirmButtonColor: '#4f29b7',
        });
        return;
      }

      // Name every reason that actually applies. A bare "some were skipped" leaves the admin with
      // no idea whether to wait a minute or fix a missing address.
      const reasons = [
        result.skippedTooSoon > 0 && t('users.invitation.reasonTooSoon', {
          count: result.skippedTooSoon,
          formattedCount: numberFormatter.format(result.skippedTooSoon),
        }),
        result.notFound > 0 && t('users.invitation.reasonNotFound', {
          count: result.notFound,
          formattedCount: numberFormatter.format(result.notFound),
        }),
      ].filter(Boolean) as string[];

      void Swal.fire({
        icon: result.sent > 0 ? 'info' : 'warning',
        title: result.sent > 0
          ? t('users.invitation.partialTitle')
          : t('users.invitation.noneSentTitle'),
        html: [
          result.sent > 0
            ? t('users.invitation.partial', {
              sent: numberFormatter.format(result.sent),
              skipped: numberFormatter.format(skipped),
            })
            : null,
          ...reasons,
        ].filter(Boolean).join('<br />'),
        confirmButtonColor: '#4f29b7',
      });
    },
    onError: error => showError(error, 'users.invitation.error'),
  });

  // Retrying SSO setup. The failure modes are meaningfully different, so they do not collapse into
  // one generic error: 409 means a human has to resolve it and retrying is pointless, 429 means slow
  // down, anything else is transient and worth another go.
  const retrySsoMutation = useMutation({
    mutationFn: (id: number) => usersApi.retrySso(id),
    onSuccess: () => {
      refreshUserDependencies();
      showSuccess('users.sso.retrySuccess');
    },
    onError: (error: unknown) => {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 409) {
        void Swal.fire({ icon: 'warning', title: t('users.sso.conflict'), text: t('users.sso.retryConflict') });
        // The row's status may have moved to CONFLICT — reflect it.
        refreshUserDependencies();
        return;
      }
      if (status === 429) {
        void Swal.fire({ icon: 'info', text: t('users.sso.retryTooSoon') });
        return;
      }
      showError(error, 'users.sso.retryFailed');
    },
  });

  // ---- Re-link: preview, then confirm ----
  // The preview is advisory and deliberately cheap to be wrong: it tells the admin whether the
  // address belongs to an existing Tuwaiq account before they commit. The write re-runs every check
  // server-side, so a stale or failed preview can never cause a wrong link.
  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedRelinkEmail(relinkEmail.trim()), 400);
    return () => window.clearTimeout(handle);
  }, [relinkEmail]);

  const relinkPreviewQuery = useQuery({
    queryKey: ['user-relink-preview', relinkUser?.id, debouncedRelinkEmail],
    queryFn: ({ signal }) => usersApi.previewRelink(relinkUser!.id, debouncedRelinkEmail, signal),
    enabled: Boolean(relinkUser) && EMAIL_PATTERN.test(debouncedRelinkEmail),
    retry: false,
    staleTime: 60_000,
  });

  // What the note under the field says. 'CHECKING' while the answer is in flight; a preview that
  // FAILED falls back to UNAVAILABLE rather than to silence, so "we could not check" never reads as
  // "this address is free".
  const relinkNote: RelinkPreviewStatus | 'CHECKING' | null = useMemo(() => {
    const typed = relinkEmail.trim();
    if (!typed || !EMAIL_PATTERN.test(typed)) return null;
    if (typed !== debouncedRelinkEmail || relinkPreviewQuery.isFetching) return 'CHECKING';
    if (relinkPreviewQuery.isError) return 'UNAVAILABLE';
    return relinkPreviewQuery.data?.status ?? null;
  }, [relinkEmail, debouncedRelinkEmail, relinkPreviewQuery.isFetching, relinkPreviewQuery.isError, relinkPreviewQuery.data]);

  const relinkMutation = useMutation({
    mutationFn: (payload: { id: number; email: string }) => usersApi.relink(payload.id, payload.email),
    onSuccess: result => {
      refreshUserDependencies();
      closeRelinkModal();
      // Which of the two things happened matters to the admin: "linked" means the person keeps the
      // password they already had, "created" means one was just emailed to the new address.
      showSuccess(result.outcome === 'Created' ? 'users.relink.createdSuccess' : 'users.relink.linkedSuccess');
    },
    onError: (error: unknown) => {
      const status = (error as { response?: { status?: number } })?.response?.status;
      // 409 = the address (or the account behind it) is spoken for. Retrying cannot change that.
      if (status === 409) {
        showError(error, 'users.relink.conflict');
        return;
      }
      if (status === 502) {
        showError(error, 'users.relink.upstreamFailed');
        return;
      }
      showError(error, 'users.relink.failed');
    },
  });

  // Only the three definite "no" answers block the button. An unreachable preview does NOT: it is
  // advisory, and the server refuses for real anyway — leaving the admin stuck behind a check that
  // cannot answer would be worse than letting them try.
  const relinkCanSubmit =
    Boolean(relinkUser)
    && EMAIL_PATTERN.test(relinkEmail.trim())
    && !relinkMutation.isPending
    && relinkNote !== 'CHECKING'
    && relinkNote !== 'UNCHANGED'
    && relinkNote !== 'EMAIL_TAKEN'
    && relinkNote !== 'CANNOT_LINK';

  function openRelinkModal(user: UserDto) {
    setRelinkUser(user);
    setRelinkEmail('');
    setDebouncedRelinkEmail('');
  }

  function closeRelinkModal() {
    if (relinkMutation.isPending) return;
    setRelinkUser(null);
    setRelinkEmail('');
    setDebouncedRelinkEmail('');
  }

  function submitRelink() {
    if (!relinkUser || !relinkCanSubmit) return;
    relinkMutation.mutate({ id: relinkUser.id, email: relinkEmail.trim() });
  }

  const createMutation = useMutation({
    mutationFn: (createData: Parameters<typeof usersApi.create>[0]) => usersApi.create(createData),
    onSuccess: created => {
      refreshUserDependencies();
      closeFormModal();
      // CONFLICT = the identity provider already holds this email; the account was still created
      // (unlinked) and links itself on the person's first SSO sign-in — tell the admin that story
      // instead of the bare success toast, so the CONFLICT badge on the row is not read as failure.
      if (created.keycloakSyncStatus === 'CONFLICT') {
        void Swal.fire({ icon: 'info', title: t('users.feedback.createSuccess'), text: t('users.sso.createdLinkOnSignIn') });
        return;
      }
      showSuccess('users.feedback.createSuccess');
    },
    onError: error => showError(error, 'users.feedback.createError'),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data: updateData }: { id: number; data: Parameters<typeof usersApi.update>[1] }) =>
      usersApi.update(id, updateData),
    onSuccess: () => {
      refreshUserDependencies();
      closeFormModal();
      showSuccess('users.feedback.updateSuccess');
    },
    onError: error => showError(error, 'users.feedback.updateError'),
  });

  // ---- Form setup (used in modal) ----
  const userFormSchema = useMemo(
    () => createUserFormSchema(t as Translate, Boolean(editingUser)),
    [editingUser, t],
  );
  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
    setValue,
    setError,
    clearErrors,
    control,
  } = useForm<UserFormData>({
    resolver: zodResolver(userFormSchema),
    defaultValues: {
      username: '', email: '', fullName: '',
      phone: '', nationalId: '', dateOfBirth: '', gender: '', campusId: '', roleIds: [], groupIds: [],
      status: 'Active', preferredLanguage: 'ar', timeZone: 'Arab Standard Time',
    },
  });

  // useWatch subscribes to specific fields only (much faster than watch())
  const selectedGender = useWatch({ control, name: 'gender' });
  const watchedRoleIds = useWatch({ control, name: 'roleIds' });
  const selectedRoleIds = useMemo(() => watchedRoleIds ?? [], [watchedRoleIds]);
  const selectedGroupIds = useWatch({ control, name: 'groupIds' }) ?? [];
  const selectedStatus = useWatch({ control, name: 'status' });
  const watchedCampusId = useWatch({ control, name: 'campusId' });
  const watchedFullName = useWatch({ control, name: 'fullName' });
  const watchedUsername = useWatch({ control, name: 'username' });
  const watchedEmail = useWatch({ control, name: 'email' });
  const watchedPhone = useWatch({ control, name: 'phone' });
  const watchedNationalId = useWatch({ control, name: 'nationalId' });

  // Group options are only needed while the form is visible for a role that can belong to groups.
  // Keeping this gate alongside the query prevents closed forms and non-group roles from issuing a
  // campus-wide dropdown request just because a previously edited user's campus remains watched.
  const hasStudentOrTeacherRole = useMemo(() => {
    if (!selectedRoleIds.length || !formRoleOptions.length) return false;
    return formRoleOptions.some(role =>
      selectedRoleIds.includes(role.id) && (role.name === 'Student' || role.name === 'Teacher'));
  }, [formRoleOptions, selectedRoleIds]);

  // Fetch form groups only when the open modal needs them.
  const {
    data: availableGroups = [],
    isLoading: groupsLoading,
    isError: groupsError,
    refetch: refetchGroups,
  } = useQuery({
    queryKey: ['groups-dropdown', accessScopeKey, watchedCampusId],
    queryFn: ({ signal }) => groupsDropdownApi.getByCampus(Number(watchedCampusId), signal),
    enabled: formModalOpen
      && hasStudentOrTeacherRole
      && !!watchedCampusId
      && Number(watchedCampusId) > 0,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: true,
  });

  const {
    data: bulkGroups = [],
    isLoading: bulkGroupsLoading,
    isError: bulkGroupsError,
    refetch: refetchBulkGroups,
  } = useQuery({
    queryKey: ['groups-dropdown', accessScopeKey, bulkCampusId],
    queryFn: ({ signal }) => groupsDropdownApi.getByCampus(Number(bulkCampusId), signal),
    enabled: bulkModalOpen
      && (bulkRole === 'Student' || bulkRole === 'Teacher')
      && Number(bulkCampusId) > 0,
    staleTime: 5 * 60 * 1000,
    refetchOnMount: true,
  });

  const formGroupOptions = useMemo<GroupDropdownDto[]>(() => {
    const options = [...availableGroups];
    if (!editingUser || String(editingUser.campusId ?? '') !== watchedCampusId) return options;

    editingUser.groups.forEach(group => {
      if (!options.some(option => option.id === group.groupId)) {
        options.push({
          id: group.groupId,
          name: group.groupName,
          code: group.groupCode,
          campusId: editingUser.campusId ?? 0,
          gradeId: null,
        });
      }
    });
    return options;
  }, [availableGroups, editingUser, watchedCampusId]);

  // A Manager's campus dropdown holds exactly their own school (API-pinned). Pre-select it so the
  // groups dropdown can load; the select itself is locked, and the campus id is NOT sent on
  // create/bulk — the server resolves the pin, so a stale tab can never target another school.
  useEffect(() => {
    if (isAdmin || activeCampuses.length !== 1) return;
    const pinned = String(activeCampuses[0].id);
    if (formModalOpen && !watchedCampusId) {
      setValue('campusId', pinned, { shouldValidate: true });
    }
    if (bulkModalOpen && !bulkCampusId) {
      setBulkCampusId(pinned);
    }
  }, [isAdmin, activeCampuses, formModalOpen, bulkModalOpen, watchedCampusId, bulkCampusId, setValue]);

  // ---- Modal handlers ----
  // NOTE: Form reset happens IN the handler (not useEffect) — fixes "second click doesn't open" bug
  // Memoized: the guided tour opens and closes this form, so it sits in the
  // tour callback's dependencies.
  const openCreateModal = useCallback(() => {
    setBulkModalOpen(false);
    setEditingUser(null);
    reset({
      username: '', email: '', fullName: '',
      phone: '', nationalId: '', dateOfBirth: '', gender: '', campusId: '', roleIds: [], groupIds: [],
      status: 'Active', preferredLanguage: 'ar', timeZone: 'Arab Standard Time',
    });
    clearErrors();
    setFormModalOpen(true);
  }, [clearErrors, reset]);

  function openEditModal(user: UserDto) {
    const resolvedRoleIds = user.roleIds?.length
      ? user.roleIds
      : user.roles
        .map(roleName => roles.find(role => role.name === roleName)?.id)
        .filter((roleId): roleId is number => roleId !== undefined);
    const roleIdValues = [...new Set(resolvedRoleIds)];

    // Use campusId directly from backend
    const campusIdStr = user.campusId ? String(user.campusId) : '';

    // Pre-fill group IDs from user's groups
    const groupIdValues = user.groups?.map(g => g.groupId) ?? [];

    // Reset form with ALL user data synchronously
    reset({
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone || '',
      nationalId: user.nationalId || '',
      dateOfBirth: user.dateOfBirth ? user.dateOfBirth.split('T')[0] : '',
      gender: user.gender || '',
      campusId: campusIdStr,
      roleIds: roleIdValues,
      groupIds: groupIdValues,
      status: user.status || 'Active',
      preferredLanguage: user.preferredLanguage || 'ar',
      timeZone: user.timeZone || 'Arab Standard Time',
    });
    clearErrors();
    setEditingUser(user);
    setFormModalOpen(true);
  }

  const closeFormModal = useCallback(() => {
    setFormModalOpen(false);
    setEditingUser(null);
  }, []);

  // ---- Lock User (matching old project: SweetAlert confirm) ----
  function handleLockUser(user: UserDto) {
    void Swal.fire({
      icon: 'warning',
      title: t('users.confirm.lockTitle'),
      text: t('users.confirm.lockText', { name: user.fullName }),
      showCancelButton: true,
      confirmButtonText: t('users.confirm.lockButton'),
      confirmButtonColor: '#dc3545',
      cancelButtonText: t('cancel'),
    }).then(result => {
      if (result.isConfirmed) {
        lockMutation.mutate(user.id);
      }
    });
  }

  // ---- Unlock User (matching old project: direct call, no confirm) ----
  function handleUnlockUser(user: UserDto) {
    unlockMutation.mutate(user.id);
  }

  // ---- Reset Password ----
  // A confirm, not a form: the server mints the new temporary password and emails it straight to
  // the user — the admin never sees or types a credential, which is the whole point.
  function handleResetPassword(user: UserDto) {
    void Swal.fire({
      icon: 'question',
      title: t('users.resetPassword.title'),
      text: t('users.resetPassword.confirmText', { name: user.fullName }),
      showCancelButton: true,
      confirmButtonText: t('users.resetPassword.confirmButton'),
      confirmButtonColor: '#4f29b7',
      cancelButtonText: t('cancel'),
      didOpen: popup => {
        // This dialog is one of the screens the guided tour opens for real, and
        // SweetAlert owns the markup, so the hook has to be set once it exists.
        popup.setAttribute('data-tour', 'user-reset-password-dialog');
      },
    }).then(result => {
      if (result.isConfirmed) {
        resetPasswordMutation.mutate(user.id);
      }
    });
  }

  // ---- Send platform invitations ----
  // A confirm that states the recipient count, per the ticket. Deliberately NOT worded as a
  // warning: no credential is rotated, so re-sending costs nothing and locks nobody out — the
  // dialog's job is to stop a mis-click on select-all, not to make the admin nervous.
  function handleSendInvitations(userIds: number[], singleName?: string) {
    if (userIds.length === 0 || sendInvitationsMutation.isPending) return;

    void Swal.fire({
      icon: 'question',
      title: t('users.invitation.confirmTitle'),
      text: userIds.length === 1 && singleName
        ? t('users.invitation.confirmOne', { name: singleName })
        : t('users.invitation.confirmMany', {
          count: userIds.length,
          formattedCount: numberFormatter.format(userIds.length),
        }),
      showCancelButton: true,
      confirmButtonText: t('users.invitation.confirmButton'),
      confirmButtonColor: '#4f29b7',
      cancelButtonText: t('cancel'),
    }).then(result => {
      if (result.isConfirmed) {
        sendInvitationsMutation.mutate(userIds);
      }
    });
  }

  // ---- Retry SSO setup ----
  // No password input: the retry mints a fresh temporary credential server-side (the one from the
  // failed create was never stored), sets it in both systems, and emails it to the user.
  function handleRetrySso(user: UserDto) {
    void Swal.fire({
      icon: 'question',
      title: t('users.sso.retryTitle'),
      text: t('users.sso.retryText', { name: user.fullName }),
      showCancelButton: true,
      confirmButtonText: t('users.sso.retryConfirm'),
      confirmButtonColor: '#4f29b7',
      cancelButtonText: t('cancel'),
    }).then(result => {
      if (result.isConfirmed) {
        retrySsoMutation.mutate(user.id);
      }
    });
  }

  // ---- Delete User (matching old project: type DELETE to confirm) ----
  function handleDeleteUser(user: UserDto) {
    void Swal.fire({
      icon: 'warning',
      title: t('users.confirm.deleteTitle'),
      text: t('users.confirm.deleteText', { name: user.fullName }),
      input: 'text',
      inputPlaceholder: t('users.confirm.deletePlaceholder'),
      showCancelButton: true,
      confirmButtonText: t('users.confirm.deleteButton'),
      confirmButtonColor: '#dc3545',
      cancelButtonText: t('cancel'),
      inputValidator: (value) => {
        if (value !== 'DELETE') {
          return t('users.confirm.deleteValidation');
        }
        return null;
      },
    }).then(result => {
      if (result.isConfirmed) {
        deleteMutation.mutate(user.id);
      }
    });
  }

  // ---- Suspend User (matching old project: SweetAlert confirm) ----
  function handleSuspendUser(user: UserDto) {
    void Swal.fire({
      icon: 'warning',
      title: t('users.confirm.suspendTitle'),
      text: t('users.confirm.suspendText', { name: user.fullName }),
      showCancelButton: true,
      confirmButtonText: t('users.confirm.suspendButton'),
      confirmButtonColor: '#dc3545',
      cancelButtonText: t('cancel'),
    }).then(result => {
      if (result.isConfirmed) {
        suspendMutation.mutate(user.id);
      }
    });
  }

  // ---- Reactivate User (matching old project: direct call, no confirm) ----
  function handleReactivateUser(user: UserDto) {
    reactivateMutation.mutate(user.id);
  }

  // ---- Link Children (Parent role — matching old project: two-column modal) ----
  async function handleLinkChildren(user: UserDto) {
    const requestId = ++linkChildrenRequestId.current;
    setLinkChildrenUser(user);
    setLinkChildrenData(null);
    setLinkChildrenLoading(true);
    setSelectedLinkedIds(new Set());
    setSelectedAvailableIds(new Set());
    setLinkedSearch('');
    setAvailableSearch('');
    try {
      const childrenData = await parentChildrenApi.getChildrenData(user.id);
      if (requestId === linkChildrenRequestId.current) {
        setLinkChildrenData(childrenData);
      }
    } catch (error) {
      if (requestId === linkChildrenRequestId.current) {
        showError(error, 'users.linkChildren.loadError');
        setLinkChildrenUser(null);
      }
    } finally {
      if (requestId === linkChildrenRequestId.current) {
        setLinkChildrenLoading(false);
      }
    }
  }

  // ---- Bulk Import configuration (React portal) ----
  const resetBulkImportState = useCallback(() => {
    setBulkCampusId('');
    setBulkRole('');
    setBulkGroupIds([]);
    setBulkStatus('Active');
    setBulkFile(null);
    setBulkDragActive(false);
    setBulkValidationError(null);
    if (bulkFileInputRef.current) bulkFileInputRef.current.value = '';
  }, []);

  function handleBulkImport() {
    if (formModalOpen && !isSaving) closeFormModal();
    setViewingUser(null);
    resetBulkImportState();
    setBulkModalOpen(true);
  }

  const closeBulkImportModal = useCallback(() => {
    if (bulkSubmitting) return;
    setBulkModalOpen(false);
    resetBulkImportState();
  }, [bulkSubmitting, resetBulkImportState]);

  function selectBulkFile(file: File | null) {
    setBulkFile(file);
    setBulkDragActive(false);
    setBulkValidationError(null);
  }

  async function downloadBulkImportTemplate() {
    // A real .xlsx (user mandate — CSV opened as one column and Excel's locale separators broke
    // round-trips). SheetJS is lazy-loaded so the users page never pays for it up front.
    // No Password column (the server generates and emails one per user); National ID is required
    // to create a user — same rule as the Add User form. Every entry column is TEXT-formatted so
    // Excel cannot eat a phone's leading zero or turn a national ID into 1.02E+09.
    // The button stays disabled until a role is chosen: without one, a parent import used to get the
    // Student/Teacher template and every parent was created with no children linked.
    if (!bulkRole) return;
    const XLSX = await import('xlsx');
    const parentTemplate = bulkRole === 'Parent';
    const header = parentTemplate ? PARENT_IMPORT_HEADER : STAFF_IMPORT_HEADER;
    const sample = parentTemplate ? PARENT_IMPORT_SAMPLE : STAFF_IMPORT_SAMPLE;
    const worksheet = XLSX.utils.aoa_to_sheet([header, sample]);
    // Pre-format 500 entry rows as text; values typed beyond that fall back to General.
    const templateRows = 500;
    for (let row = 1; row <= templateRows; row++) {
      for (let col = 0; col < header.length; col++) {
        const address = XLSX.utils.encode_cell({ r: row, c: col });
        const existing = worksheet[address] as { v?: unknown } | undefined;
        worksheet[address] = { t: 's', v: existing?.v ?? '', z: '@' };
      }
    }
    worksheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: templateRows, c: header.length - 1 } });
    worksheet['!cols'] = [{ wch: 24 }, { wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 14 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Users');
    XLSX.writeFile(workbook, parentTemplate ? 'Parents_Import_Template.xlsx' : 'BulkImport_Template.xlsx');
  }

  async function readBulkImportFile(file: File): Promise<string> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = detectImportFileKind(bytes);
    if (kind === 'numbers') throw new ImportFileError(t('users.bulk.validationNumbersFile'));
    if (kind === 'unsupported') throw new ImportFileError(t('users.bulk.validationNotSpreadsheet'));
    if (kind === 'xlsx') {
      // Parse in the browser and ship the existing semicolon-CSV wire format — the server-side
      // validation/worker pipeline stays untouched, and CSV files keep working below. A real
      // workbook saved with a .csv name takes this path too.
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(bytes, { type: 'array' });
      const worksheet = workbook.Sheets[workbook.SheetNames[0]];
      if (!worksheet) throw new Error(t('users.bulk.validationFileRead'));
      const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, raw: true, defval: '' });
      // Numbers stringify from the raw value (full precision), never the displayed 1.02E+09 form.
      // A newline typed into a cell (alt+enter) collapses to a space: the server reads one line per
      // row, so sending it would split the row in two and shift every row number after it.
      const toText = (cell: unknown): string =>
        typeof cell === 'number' && Number.isInteger(cell)
          ? cell.toFixed(0)
          : String(cell ?? '').replace(/[\r\n]+/g, ' ').trim();
      // Interior blank rows stay, so every reported row number still matches the spreadsheet — but
      // the template's 499 pre-formatted empty entry rows are cut. The server counts each non-blank
      // line as a data row, so shipping them leaves the progress bar stuck far short of 100%.
      const cells = rows.map(row => row.map(toText));
      const lastFilled = cells.reduce((last, row, index) => (row.some(cell => cell !== '') ? index : last), -1);
      return cells
        .slice(0, lastFilled + 1)
        .map(row => row.map(cell => /[;"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell).join(';'))
        .join('\n');
    }
    return decodeImportText(bytes);
  }

  async function submitBulkImport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (bulkSubmitting) return;

    if (!bulkRole) {
      setBulkValidationError(t('users.bulk.validationRole'));
      return;
    }
    if (bulkRole === 'Parent' && isAdmin && !bulkCampusId) {
      setBulkValidationError(t('users.bulk.parentSchoolRequired'));
      return;
    }
    if (bulkRole !== 'Parent' && bulkGroupIds.length === 0) {
      setBulkValidationError(t('users.bulk.validationGroups'));
      return;
    }
    if (!bulkFile) {
      setBulkValidationError(t('users.bulk.validationFileRequired'));
      return;
    }
    if (bulkFile.size > 5 * 1024 * 1024) {
      setBulkValidationError(t('users.bulk.validationFileSize'));
      return;
    }
    const lowerFileName = bulkFile.name.toLowerCase();
    if (!lowerFileName.endsWith('.xlsx') && !lowerFileName.endsWith('.csv')) {
      setBulkValidationError(t('users.bulk.validationFileType'));
      return;
    }

    setBulkValidationError(null);
    setBulkSubmitting(true);

    let csvData: string;
    try {
      csvData = await readBulkImportFile(bulkFile);
    } catch (error) {
      setBulkValidationError(error instanceof ImportFileError ? error.message : t('users.bulk.validationFileRead'));
      setBulkSubmitting(false);
      return;
    }

    // Blank out the template's sample row only while it is still the untouched example. A row the
    // school typed over is kept — if it still carries the sample email the server rejects that row
    // with a reason, instead of the row silently vanishing. Blanking (not removing) keeps every
    // later row number equal to the spreadsheet's. Splits on every line ending, the same as the
    // server's ImportCsvReader.SplitLines — Excel's "CSV (Macintosh)" writes CR-only lines.
    const csvLines = csvData.split(/\r\n|\r|\n/).map(line => (isUntouchedImportSample(line) ? '' : line));
    csvData = csvLines.join('\n');

    const fileProblem = findImportFileProblem(csvLines, bulkRole === 'Parent');
    if (fileProblem) {
      setBulkValidationError(t({
        noDataRows: 'users.bulk.validationNoDataRows',
        staffTemplateForParent: 'users.bulk.validationStaffTemplateForParent',
        parentTemplateForStaff: 'users.bulk.validationParentTemplateForStaff',
      }[fileProblem]));
      setBulkSubmitting(false);
      return;
    }

    const request: BulkImportUserRequest = {
      csvData,
      // Manager imports omit the campus — the server pins the job to their school (see onSubmit).
      campusId: isAdmin && bulkCampusId ? Number(bulkCampusId) : null,
      role: bulkRole,
      groupIds: bulkRole === 'Parent' ? [] : bulkGroupIds,
      status: bulkStatus,
    };

    setBulkModalOpen(false);
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

    // Progress popup, updated live from the worker's processed-row count while it runs.
    const bulkProgressInner = (processed: number, total: number): string => {
      const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
      return `
        <div dir="${i18n.dir()}" style="text-align:center;padding:24px 0 8px;">
          <div style="width:56px;height:56px;border-radius:50%;background:#4f29b7;margin:0 auto 18px;display:flex;align-items:center;justify-content:center;">
            <i class="fas fa-spinner fa-spin" style="font-size:24px;color:white;"></i>
          </div>
          <h3 style="color:#2c3e50;font-size:18px;font-weight:700;margin:0 0 6px;">${escapeHtml(t('users.bulk.processingTitle'))}</h3>
          <p style="color:#868e96;font-size:13px;margin:0 0 16px;">${escapeHtml(t('users.bulk.processingText'))}</p>
          <div style="background:#eee;border-radius:6px;height:8px;overflow:hidden;margin:0 8px;">
            <div style="width:${pct}%;height:100%;background:#4f29b7;transition:width .3s;"></div>
          </div>
          <p style="color:#495057;font-size:12.5px;margin:10px 0 0;font-weight:600;">${escapeHtml(t('users.bulk.progressCount', { processed: numberFormatter.format(processed), total: numberFormatter.format(total) }))}</p>
        </div>`;
    };

    void Swal.fire({
      html: bulkProgressInner(0, 0),
      allowOutsideClick: false,
      allowEscapeKey: false,
      showConfirmButton: false,
      width: '400px',
      customClass: { popup: 'users-bulk-feedback' },
    });

    try {
      // Queue the import (returns at once), then poll for progress until the worker finishes.
      let job = await bulkImportApi.import(request);
      const jobId = job.id;
      const deadline = Date.now() + 15 * 60 * 1000; // safety cap so a stuck job cannot poll forever
      while (job.status !== 'COMPLETED' && job.status !== 'FAILED') {
        if (Date.now() > deadline) throw new Error('bulk import timed out');
        await new Promise<void>(resolve => setTimeout(resolve, 1500));
        job = await bulkImportApi.getJob(jobId);
        const container = Swal.getHtmlContainer();
        if (container) container.innerHTML = bulkProgressInner(job.processedRows, job.totalRows);
      }

      if (importWasRefused(job)) {
        await Swal.fire({
          icon: 'error',
          title: t('users.feedback.errorTitle'),
          text: job.message || t('users.bulk.importFailedText'),
          confirmButtonColor: '#4f29b7',
          customClass: { popup: 'users-bulk-feedback' },
        });
        return;
      }

      if (bulkRole === 'Parent') {
        Swal.close();
        refreshUserDependencies();
        setBulkModalOpen(false);
        navigate(`/users/import/${job.id}`, { state: { fileName: bulkFile.name } });
        return;
      }

      // COMPLETED — map the job onto the existing result-summary shape. When the server sent
      // structured issues, render each in the viewer's language through the apiErrors catalog
      // (unknown codes fall back to the code itself); older stored jobs keep the English strings.
      const issueLine = (issue: NonNullable<BulkImportJobDto['issues']>[number]): string => {
        const messages = issue.codes
          .map(entry => t(`apiErrors.${entry.code}`, { ...entry.params, defaultValue: entry.code }))
          .join(t('users.bulk.issueJoin'));
        if (issue.rowNumber <= 0) return messages;
        const label = issue.username
          ? t('users.bulk.rowLabelNamed', { row: numberFormatter.format(issue.rowNumber), username: issue.username })
          : t('users.bulk.rowLabel', { row: numberFormatter.format(issue.rowNumber) });
        return `${label}: ${messages}`;
      };
      const issues = job.issues ?? [];
      const importResult = {
        success: job.errorCount === 0,
        totalProcessed: job.processedRows,
        successCount: job.successCount,
        errorCount: job.errorCount,
        warningCount: job.warningCount,
        duration: job.completedAt
          ? Math.max(0, (new Date(job.completedAt).getTime() - new Date(job.createdAt).getTime()) / 1000)
          : 0,
        errors: issues.length > 0 ? issues.filter(i => !i.isWarning).map(issueLine) : job.errors,
        warnings: issues.length > 0 ? issues.filter(i => i.isWarning).map(issueLine) : job.warnings,
      };
      const hasIssues = !importResult.success || importResult.errorCount > 0 || importResult.warningCount > 0;
      const resultsHtml = `
        <div dir="${i18n.dir()}" style="text-align:center;padding:8px 0;">
          <div style="width:64px;height:64px;border-radius:50%;background:${hasIssues ? '#fff3cd' : '#f3f0ff'};margin:0 auto 16px;display:flex;align-items:center;justify-content:center;">
            <i class="fas fa-${hasIssues ? 'exclamation-triangle' : 'check'}" style="font-size:28px;color:${hasIssues ? '#9a6700' : '#4f29b7'};"></i>
          </div>
          <h3 style="color:#2c3e50;font-size:18px;font-weight:700;margin:0 0 4px;">
            ${escapeHtml(t(hasIssues ? 'users.bulk.completedWithIssues' : 'users.bulk.completedSuccessfully'))}
          </h3>
          <p style="color:#868e96;font-size:13px;margin:0 0 20px;">
            ${escapeHtml(t(hasIssues ? 'users.bulk.resultSummaryIssues' : 'users.bulk.resultSummarySuccess'))}
          </p>

          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px;">
            <div style="background:#f8f9fa;border-radius:10px;padding:14px 8px;">
              <div style="font-size:22px;font-weight:800;color:#4f29b7;">${escapeHtml(numberFormatter.format(importResult.totalProcessed))}</div>
              <div style="font-size:11px;color:#868e96;font-weight:500;margin-top:2px;">${escapeHtml(t('users.bulk.total'))}</div>
            </div>
            <div style="background:#f0faf6;border-radius:10px;padding:14px 8px;">
              <div style="font-size:22px;font-weight:800;color:#287a3d;">${escapeHtml(numberFormatter.format(importResult.successCount))}</div>
              <div style="font-size:11px;color:#868e96;font-weight:500;margin-top:2px;">${escapeHtml(t('users.bulk.created'))}</div>
            </div>
            <div style="background:${importResult.errorCount ? '#fff5f5' : '#f0faf6'};border-radius:10px;padding:14px 8px;">
              <div style="font-size:22px;font-weight:800;color:${importResult.errorCount ? '#b4232f' : '#287a3d'};">${escapeHtml(numberFormatter.format(importResult.errorCount))}</div>
              <div style="font-size:11px;color:#868e96;font-weight:500;margin-top:2px;">${escapeHtml(t('users.bulk.errors'))}</div>
            </div>
            <div style="background:#f8f9fa;border-radius:10px;padding:14px 8px;">
              <div style="font-size:22px;font-weight:800;color:#6c757d;">${escapeHtml(t('users.bulk.durationSeconds', { duration: numberFormatter.format(Number(importResult.duration.toFixed(1))) }))}</div>
              <div style="font-size:11px;color:#868e96;font-weight:500;margin-top:2px;">${escapeHtml(t('users.bulk.time'))}</div>
            </div>
          </div>

          ${importResult.errors.length > 0 ? `
            <div style="background:#fff5f5;border:1px solid #fed7d7;border-radius:10px;padding:14px;text-align:start;margin-bottom:12px;">
              <div style="font-size:12.5px;font-weight:700;color:#c53030;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
                <i class="fas fa-times-circle"></i> ${escapeHtml(t('users.bulk.errors'))} (${escapeHtml(numberFormatter.format(importResult.errors.length))})
              </div>
              <div style="max-height:120px;overflow-y:auto;font-size:12px;">
                ${importResult.errors.map(error => `
                  <div style="padding:5px 0;border-bottom:1px solid #fee;color:#742a2a;display:flex;align-items:flex-start;gap:6px;">
                    <i class="fas fa-chevron-right" style="font-size:8px;margin-top:4px;color:#fc8181;flex-shrink:0;"></i>
                    <span>${escapeHtml(error)}</span>
                  </div>
                `).join('')}
              </div>
            </div>
          ` : ''}

          ${importResult.warnings.length > 0 ? `
            <div style="background:#fffbeb;border:1px solid #fef3c7;border-radius:10px;padding:14px;text-align:start;">
              <div style="font-size:12.5px;font-weight:700;color:#92400e;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
                <i class="fas fa-exclamation-triangle"></i> ${escapeHtml(t('users.bulk.warnings'))} (${escapeHtml(numberFormatter.format(importResult.warnings.length))})
              </div>
              <div style="max-height:80px;overflow-y:auto;font-size:12px;">
                ${importResult.warnings.map(warning => `<div style="padding:3px 0;color:#78350f;">${escapeHtml(warning)}</div>`).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      `;

      await Swal.fire({
        html: resultsHtml,
        width: '520px',
        confirmButtonText: t('users.bulk.done'),
        confirmButtonColor: '#4f29b7',
        allowOutsideClick: false,
        allowEscapeKey: false,
        customClass: { popup: 'users-bulk-feedback' },
      });
      refreshUserDependencies();
    } catch (error: unknown) {
      await Swal.fire({
        icon: 'error',
        title: t('users.feedback.errorTitle'),
        text: getMutationError(error, 'users.bulk.importFailedText'),
        confirmButtonColor: '#4f29b7',
        customClass: { popup: 'users-bulk-feedback' },
      });
    } finally {
      setBulkSubmitting(false);
      resetBulkImportState();
    }
  }

  function closeLinkChildrenModal() {
    if (linkChildrenSaving) return;
    linkChildrenRequestId.current += 1;
    setLinkChildrenUser(null);
    setLinkChildrenData(null);
    setSelectedLinkedIds(new Set());
    setSelectedAvailableIds(new Set());
  }

  async function linkSelectedChildren() {
    if (!linkChildrenUser || selectedAvailableIds.size === 0 || linkChildrenSaving) return;
    const parentId = linkChildrenUser.id;
    const studentIds = [...selectedAvailableIds];
    setLinkChildrenSaving(true);
    const results = await Promise.allSettled(
      studentIds.map(studentId => parentChildrenApi.linkChild(parentId, studentId)),
    );
    const successCount = results.filter(result => result.status === 'fulfilled').length;
    const failureCount = results.length - successCount;
    try {
      const childrenData = await parentChildrenApi.getChildrenData(parentId);
      setLinkChildrenData(childrenData);
      setSelectedAvailableIds(new Set());
    } catch (error) {
      showError(error, 'users.linkChildren.loadError');
    } finally {
      setLinkChildrenSaving(false);
    }
    void Swal.fire({
      icon: failureCount === 0 ? 'success' : successCount > 0 ? 'warning' : 'error',
      title: failureCount === 0 ? t('users.feedback.successTitle') : t('users.feedback.errorTitle'),
      text: failureCount === 0
        ? t('users.linkChildren.linkSuccess', { count: successCount })
        : successCount > 0
          ? t('users.linkChildren.partialLink', { success: successCount, failed: failureCount })
          : t('users.linkChildren.linkError'),
      confirmButtonColor: '#4f29b7',
    });
  }

  async function unlinkSelectedChildren() {
    if (!linkChildrenUser || selectedLinkedIds.size === 0 || linkChildrenSaving) return;
    const parentId = linkChildrenUser.id;
    const studentIds = [...selectedLinkedIds];
    setLinkChildrenSaving(true);
    const results = await Promise.allSettled(
      studentIds.map(studentId => parentChildrenApi.unlinkChild(parentId, studentId)),
    );
    const successCount = results.filter(result => result.status === 'fulfilled').length;
    const failureCount = results.length - successCount;
    try {
      const childrenData = await parentChildrenApi.getChildrenData(parentId);
      setLinkChildrenData(childrenData);
      setSelectedLinkedIds(new Set());
    } catch (error) {
      showError(error, 'users.linkChildren.loadError');
    } finally {
      setLinkChildrenSaving(false);
    }
    void Swal.fire({
      icon: failureCount === 0 ? 'success' : successCount > 0 ? 'warning' : 'error',
      title: failureCount === 0 ? t('users.feedback.successTitle') : t('users.feedback.errorTitle'),
      text: failureCount === 0
        ? t('users.linkChildren.unlinkSuccess', { count: successCount })
        : successCount > 0
          ? t('users.linkChildren.partialUnlink', { success: successCount, failed: failureCount })
          : t('users.linkChildren.unlinkError'),
      confirmButtonColor: '#4f29b7',
    });
  }

  function toggleLinkedId(id: number) {
    setSelectedLinkedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAvailableId(id: number) {
    setSelectedAvailableIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onSubmit(formData: UserFormData) {
    if (!isEditingSelf && hasStudentOrTeacherRole && selectedGroupIds.length === 0) {
      setError('groupIds', { type: 'manual', message: t('users.validation.groupsRequired') });
      return;
    }
    clearErrors('groupIds');
    const roleIds = formData.roleIds;
    const groupIds = hasStudentOrTeacherRole ? selectedGroupIds : [];
    if (editingUser) {
      updateMutation.mutate({
        id: editingUser.id,
        data: {
          username: formData.username,
          email: formData.email,
          fullName: formData.fullName,
          phone: formData.phone || null,
          // Always a string: "" clears the stored ID, a value replaces it. null would mean
          // "no change" (the stale-client guard) and lock the admin out of clearing it.
          nationalId: formData.nationalId ?? '',
          dateOfBirth: formData.dateOfBirth || null,
          gender: formData.gender || null,
          status: formData.status || editingUser.status,
          campusId: formData.campusId ? Number(formData.campusId) : null,
          preferredLanguage: formData.preferredLanguage || 'ar',
          timeZone: formData.timeZone || 'Arab Standard Time',
          roleIds,
          groupIds,
        },
      });
    } else {
      createMutation.mutate({
        username: formData.username,
        email: formData.email,
        fullName: formData.fullName,
        phone: formData.phone || null,
        nationalId: formData.nationalId ?? '',
        dateOfBirth: formData.dateOfBirth || null,
        gender: formData.gender || null,
        // A Manager's create omits the campus — the server pins it to their school, so a stale
        // tab (moved Manager) can never echo an old campus id into the request.
        campusId: isAdmin && formData.campusId ? Number(formData.campusId) : null,
        preferredLanguage: formData.preferredLanguage || 'ar',
        timeZone: formData.timeZone || 'Arab Standard Time',
        roleIds,
        groupIds,
      });
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  // ---- Role selection ----
  function toggleRole(roleId: number) {
    if (isEditingSelf) return;
    // Single-select in BOTH modes (Round 4): picking a role replaces the previous one.
    const nextRoleIds = [roleId];
    setValue('roleIds', nextRoleIds, { shouldDirty: true, shouldValidate: true });
    const keepsGroupRole = roles.some(role =>
      nextRoleIds.includes(role.id) && (role.name === 'Student' || role.name === 'Teacher'));
    if (!keepsGroupRole) {
      setValue('groupIds', [], { shouldDirty: true });
      clearErrors('groupIds');
    }
  }

  // ---- Helpers ----
  function getInitials(name: string): string {
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
  }

  function getRoleClass(userRoles: string[]): string {
    return (userRoles[0] || '').toLowerCase();
  }

  function getEffectiveStatus(user: UserDto): string {
    return user.isLocked ? 'Locked' : user.status;
  }

  function translateRole(role: string): string {
    return t(`users.enums.roles.${role.toLowerCase()}`, { defaultValue: role });
  }

  function translateStatus(status: string): string {
    return t(`users.enums.statuses.${status.toLowerCase()}`, { defaultValue: status });
  }

  // Single sign-on state, shown only when this admin can act on it — which means FAILED and nothing
  // else. SYNCED is the expected outcome and a badge on every row would be noise; NOT_ATTEMPTED
  // means provisioning is switched off, a deployment fact; LINKED is a normal, healthy account.
  function renderSsoBadge(user: UserDto) {
    // CONFLICT is deliberately silent too. It resolves itself on the person's first SSO sign-in and
    // offers no retry action, so on screen it was a permanent warning about nothing the admin could
    // do — read as a fault they had caused. The create-time dialog still explains it once.
    if (user.keycloakSyncStatus !== 'FAILED') return null;

    return (
      <span className="user-sso-badge failed" title={t('users.sso.failedHint')}>
        {t('users.sso.failed')}
      </span>
    );
  }

  function formatUserGroup(group: UserGroupInfoDto): string {
    const code = group.groupCode?.trim();
    return code ? `${code} - ${group.groupName}` : group.groupName;
  }

  function translateGender(gender: string): string {
    return t(`users.enums.genders.${gender.toLowerCase()}`, { defaultValue: gender });
  }

  function formatDate(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t('users.details.notProvided') : dateFormatter.format(date);
  }

  // Map role name → Font Awesome icon (matching old project exactly)
  function getRoleIcon(roleName: string) {
    switch (roleName.toLowerCase()) {
      case 'student': return faUserGraduate;
      case 'teacher': return faChalkboardTeacher;
      case 'parent': return faUserFriends;
      case 'manager': return faBriefcase;
      case 'admin': return faUserShield;
      default: return faUserGraduate;
    }
  }

  // ---- Client-side filtering (memoized) ----
  const visibleUsers = useMemo(() => data?.items ?? [], [data?.items]);
  // ---- Compute stats (memoized — avoids recomputing on modal state changes) ----
  const stats = statsData ?? {
    total: 0,
    active: 0,
    students: 0,
    teachers: 0,
    managers: 0,
    attention: 0,
  };

  const hasActiveFilters = Boolean(search || filterCampus || filterRole || filterStatus);

  function clearFilters(): void {
    // setSearch('') already resets page=1 in the same URL write; a trailing setPage(1)
    // would navigate again from stale params and resurrect the old search term.
    setSearch('');
    setFilterCampus('');
    setFilterRole('');
    setFilterStatus('');
  }

  // ---- Invitation selection, scoped to the rows on screen ----
  // Pruned against the rows actually rendered: paging, filtering or a refetch that drops a row
  // must not leave an invisible id armed behind the header checkbox.
  const visibleInviteIds = useMemo(() => visibleUsers.map(user => user.id), [visibleUsers]);
  const selectedVisibleInviteIds = useMemo(
    () => visibleInviteIds.filter(id => selectedInviteIds.has(id)),
    [visibleInviteIds, selectedInviteIds],
  );
  const allVisibleSelected = visibleInviteIds.length > 0
    && selectedVisibleInviteIds.length === visibleInviteIds.length;

  useEffect(() => {
    // The header checkbox is tri-state: some-but-not-all reads as indeterminate rather than as
    // "none", which is the only honest rendering when a page is partly selected. React has no
    // prop for it, so it is set on the node.
    if (selectAllInviteRef.current) {
      selectAllInviteRef.current.indeterminate = selectedVisibleInviteIds.length > 0
        && !allVisibleSelected;
    }
  }, [selectedVisibleInviteIds.length, allVisibleSelected]);

  // Selection is per-screen. Paging, re-filtering or RE-SORTING clears it, so the count in the bar
  // always equals the rows the admin can actually see — a send can never quietly include a row that
  // scrolled out of view three filters ago. debouncedSearch, not search: clearing on every
  // keystroke would fight the typist.
  //
  // Sorting has to be in here even though handleSort calls setPage(1): page 1 IS the default, so
  // that call is a no-op precisely when the risk is highest, while the server still returns a
  // different page-1 set for the new order.
  useEffect(() => {
    setSelectedInviteIds(new Set());
  }, [
    page,
    pageSize,
    debouncedSearch,
    filterCampus,
    filterRole,
    filterStatus,
    sortColumn,
    sortDirection,
  ]);

  function toggleInviteSelection(userId: number) {
    setSelectedInviteIds(previous => {
      const next = new Set(previous);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelectedInviteIds(previous => {
      const next = new Set(previous);
      if (allVisibleSelected) visibleInviteIds.forEach(id => next.delete(id));
      else visibleInviteIds.forEach(id => next.add(id));
      return next;
    });
  }

  function isUserActionPending(userId: number): boolean {
    return (
      (sendInvitationsMutation.isPending
        && sendInvitationsMutation.variables?.includes(userId) === true)
      || (deleteMutation.isPending && deleteMutation.variables === userId)
      || (suspendMutation.isPending && suspendMutation.variables === userId)
      || (reactivateMutation.isPending && reactivateMutation.variables === userId)
      || (lockMutation.isPending && lockMutation.variables === userId)
      || (unlockMutation.isPending && unlockMutation.variables === userId)
      || (resetPasswordMutation.isPending && resetPasswordMutation.variables === userId)
    );
  }

  // ---- Pagination (memoized) ----
  const totalPages = data?.totalPages ?? 1;
  const listTotal = data?.totalCount ?? 0;
  const startItem = listTotal > 0 ? (page - 1) * pageSize + 1 : 0;
  const endItem = Math.min(page * pageSize, listTotal);

  const pageNumbers = useMemo(() => {
    const pages: number[] = [];
    const maxVisible = 5;
    let start = Math.max(1, page - Math.floor(maxVisible / 2));
    const end = Math.min(totalPages, start + maxVisible - 1);
    start = Math.max(1, end - maxVisible + 1);
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  }, [page, totalPages]);

  useEffect(() => {
    if (data && totalPages > 0 && page > totalPages) setPage(totalPages);
  }, [data, page, setPage, totalPages]);

  useEffect(() => {
    const activeDialog = formModalOpen
      ? formDialogRef.current
      : viewingUser
        ? viewDialogRef.current
        : linkChildrenUser
          ? childrenDialogRef.current
          : bulkModalOpen
            ? bulkDialogRef.current
            : null;
    if (!activeDialog) return;

    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.classList.add('users-modal-open');
    activeDialog.focus();

    function handleDialogKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        if (formModalOpen && !isSaving) closeFormModal();
        else if (viewingUser) setViewingUser(null);
        else if (linkChildrenUser && !linkChildrenSaving) {
          linkChildrenRequestId.current += 1;
          setLinkChildrenUser(null);
          setLinkChildrenData(null);
          setSelectedLinkedIds(new Set());
          setSelectedAvailableIds(new Set());
        }
        else if (bulkModalOpen && !bulkSubmitting) closeBulkImportModal();
        return;
      }
      if (event.key !== 'Tab' || !activeDialog) return;
      const focusable = [...activeDialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      )].filter(element => element.offsetParent !== null);
      if (focusable.length === 0) {
        event.preventDefault();
        activeDialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleDialogKeyDown);
    return () => {
      document.removeEventListener('keydown', handleDialogKeyDown);
      document.body.style.overflow = previousOverflow;
      document.body.classList.remove('users-modal-open');
      previouslyFocused?.focus();
    };
  }, [bulkModalOpen, bulkSubmitting, closeBulkImportModal, formModalOpen, isSaving, linkChildrenSaving, linkChildrenUser, viewingUser]);

  const registerTour = useProductTourStore(state => state.registerTour);
  const autoTourRequestedRef = useRef(false);
  // The tour opens this page's screens for real, and four of the openers are
  // plain functions re-created on every render. A ref keeps those out of the
  // callback's dependency list without ever handing it a stale closure.
  const tourHandlersRef = useRef({
    handleResetPassword,
    handleLinkChildren,
    openEditModal,
    handleBulkImport,
  });
  useEffect(() => {
    tourHandlersRef.current = {
      handleResetPassword,
      handleLinkChildren,
      openEditModal,
      handleBulkImport,
    };
  });

  const startUsersTour = useCallback(async (onStopped: () => void) => {
    if (
      !currentUserId
      || !tourAudience
      || !pageTour
      || formModalOpen
      || viewingUser
      || linkChildrenUser
      || bulkModalOpen
      // A confirm dialog or an already-open kebab would sit under the tour's own
      // overlay with no way out of it.
      || Swal.isVisible()
      || document.querySelector('.eq-menu-pop')
    ) {
      return false;
    }

    // The tour walks the first row. Link children is a per-row action carried
    // only by a Parent row, so that one screen samples the first parent on the
    // page (for an Admin and a Manager alike) and is dropped entirely when the
    // page holds none.
    const sample = visibleUsers[0];
    const parentSample = visibleUsers.find(user =>
      user.roles.some(role => role.toLowerCase() === 'parent'),
    );

    const shown = await showUsersTour(
      i18n.resolvedLanguage || i18n.language,
      tourAudience,
      {
        openForm: openCreateModal,
        closeForm: closeFormModal,
        openView: sample ? () => setViewingUser(sample) : null,
        closeView: () => setViewingUser(null),
        // Edit is the create dialog reopened on this row, so it opens and closes
        // through the same handlers the row menu uses.
        openEdit: sample
          ? () => tourHandlersRef.current.openEditModal(sample)
          : null,
        closeEdit: closeFormModal,
        openResetPassword: sample
          ? () => tourHandlersRef.current.handleResetPassword(sample)
          : null,
        // Idempotent: SweetAlert's close is a no-op when nothing is open.
        closeResetPassword: () => Swal.close(),
        openLinkChildren: parentSample
          ? () => void tourHandlersRef.current.handleLinkChildren(parentSample)
          : null,
        closeLinkChildren: () => {
          // Same teardown as the dialog's own close, minus the save guard: the
          // tour must be able to shut it on every exit path.
          linkChildrenRequestId.current += 1;
          setLinkChildrenUser(null);
          setLinkChildrenData(null);
          setSelectedLinkedIds(new Set());
          setSelectedAvailableIds(new Set());
        },
        openBulkImport: () => tourHandlersRef.current.handleBulkImport(),
        // The dialog's own close refuses while a submit is in flight; the tour
        // has to be able to shut it on every exit path, so it tears down directly.
        closeBulkImport: () => {
          setBulkModalOpen(false);
          resetBulkImportState();
        },
      },
      onStopped,
    );

    if (shown) {
      markTourSeen({
        ...pageTour,
        userId: currentUserId,
      });
    }

    return shown;
  }, [
    bulkModalOpen,
    closeFormModal,
    currentUserId,
    formModalOpen,
    i18n.language,
    i18n.resolvedLanguage,
    linkChildrenUser,
    openCreateModal,
    pageTour,
    resetBulkImportState,
    tourAudience,
    viewingUser,
    visibleUsers,
  ]);
  const startUsersTourRef = useRef(startUsersTour);

  useEffect(() => {
    startUsersTourRef.current = startUsersTour;
  }, [startUsersTour]);

  useEffect(() => {
    if (!pageTour || !currentUserId) return undefined;

    return registerTour({
      id: pageTour.tourId,
      start: onStopped => startUsersTourRef.current(onStopped),
      stop: stopUsersTour,
    });
  }, [currentUserId, pageTour, registerTour]);

  const pageHasRealContent = !((isLoading || isError) && !data);
  const tourBlockedByModal = (
    formModalOpen
    || Boolean(viewingUser)
    || Boolean(linkChildrenUser)
    || bulkModalOpen
  );

  useEffect(() => {
    if (
      autoTourRequestedRef.current
      || !pageTour
      || !currentUserId
      || !pageHasRealContent
      || tourBlockedByModal
      || hasSeenTour({ ...pageTour, userId: currentUserId })
    ) {
      return undefined;
    }

    autoTourRequestedRef.current = true;
    const timer = window.setTimeout(() => {
      void useProductTourStore
        .getState()
        .startTour(pageTour.tourId);
    }, 350);

    return () => window.clearTimeout(timer);
  }, [
    currentUserId,
    pageHasRealContent,
    pageTour,
    tourBlockedByModal,
  ]);

  // ---- Loading state ----
  if (isLoading && !data) {
    return <UsersPageSkeleton />;
  }

  if (isError && !data) {
    return (
      <section className="users-page users-load-error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <h1>{t('users.loadErrorTitle')}</h1>
        <p>{t('users.loadErrorText')}</p>
        <button type="button" className="btn-primary users-retry-btn" onClick={() => void refetch()}>
          <RefreshCw aria-hidden="true" />
          {t('users.retry')}
        </button>
      </section>
    );
  }

  return (
    <div className="users-page" aria-busy={isFetching || statsFetching}>
      {/* ======== HERO SECTION ======== */}
      <div className="users-hero">
        <div className="hero-content">
          <div className="hero-header">
            <div>
              <h1 className="hero-title">
                <Users aria-hidden="true" />
                {t('users.title')}
              </h1>
              <p className="hero-subtitle">{t('users.subtitle')}</p>
            </div>
          </div>

          {/* Statistics Cards — 10 cards matching old project */}
          <div className="stats-container">
            <div className="stat-card stat-primary">
              <div className="stat-icon"><Users aria-hidden="true" /></div>
              <span className="stat-number">
                {statsLoading && !statsData ? <span className="users-stat-skeleton" aria-hidden="true" /> : numberFormatter.format(stats.total)}
              </span>
              <div className="stat-label">{t('users.stats.total')}</div>
            </div>
            <div className="stat-card stat-success">
              <div className="stat-icon"><UserCheckIcon aria-hidden="true" /></div>
              <span className="stat-number">
                {statsLoading && !statsData ? <span className="users-stat-skeleton" aria-hidden="true" /> : numberFormatter.format(stats.active)}
              </span>
              <div className="stat-label">{t('users.stats.active')}</div>
            </div>
            <div className="stat-card stat-info">
              <div className="stat-icon"><BookOpen aria-hidden="true" /></div>
              <span className="stat-number">
                {statsLoading && !statsData ? <span className="users-stat-skeleton" aria-hidden="true" /> : numberFormatter.format(stats.students)}
              </span>
              <div className="stat-label">{t('users.stats.students')}</div>
            </div>
            <div className="stat-card stat-purple">
              <div className="stat-icon"><Award aria-hidden="true" /></div>
              <span className="stat-number">
                {statsLoading && !statsData ? <span className="users-stat-skeleton" aria-hidden="true" /> : numberFormatter.format(stats.teachers)}
              </span>
              <div className="stat-label">{t('users.stats.teachers')}</div>
            </div>
            <div className="stat-card stat-blue">
              <div className="stat-icon"><Shield aria-hidden="true" /></div>
              <span className="stat-number">
                {statsLoading && !statsData ? <span className="users-stat-skeleton" aria-hidden="true" /> : numberFormatter.format(stats.managers)}
              </span>
              <div className="stat-label">{t('users.stats.managers')}</div>
            </div>
            <div className="stat-card stat-danger">
              <div className="stat-icon"><AlertTriangle aria-hidden="true" /></div>
              <span className="stat-number">
                {statsLoading && !statsData ? <span className="users-stat-skeleton" aria-hidden="true" /> : numberFormatter.format(stats.attention)}
              </span>
              <div className="stat-label">{t('users.stats.attention')}</div>
            </div>
          </div>

          {statsLoading && !statsData && (
            <span className="visually-hidden" role="status" aria-live="polite">{t('users.stats.loading')}</span>
          )}
          {statsError && (
            <div className="users-stats-error" role="alert">
              <span>{t('users.stats.loadError')}</span>
              <button type="button" onClick={() => void refetchStats()}>
                <RefreshCw aria-hidden="true" /> {t('users.retry')}
              </button>
            </div>
          )}

          {/* Filter Section — Campus / Role / Status */}
          <div className="filter-section" data-tour="users-filters">
            <div className="row g-3">
              {isAdmin && (
                <div className="col-md-4">
                  <label htmlFor="users-campus-filter">{t('users.filters.campusLabel')}</label>
                  <select
                    id="users-campus-filter"
                    value={filterCampus}
                    aria-label={t('users.a11y.filterByCampus')}
                    disabled={campusesLoading || campusesError}
                    onChange={event => { setFilterCampus(event.target.value); setPage(1); }}
                  >
                    <option value="">
                      {campusesLoading
                        ? t('users.form.loadingCampuses')
                        : campusesError
                          ? t('users.form.optionsLoadError')
                          : t('users.filters.allCampuses')}
                    </option>
                    {campuses.map(c => (
                      <option key={c.id} value={c.id}>{campusOptionLabel(c)}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Same col-md-4 width for every role: a Manager's two selects at col-md-6 stretched
                  across the whole card and read as two lonely controls far apart. */}
              <div className="col-md-4">
                <label htmlFor="users-role-filter">{t('users.filters.roleLabel')}</label>
                <select
                  id="users-role-filter"
                  value={filterRole}
                  aria-label={t('users.a11y.filterByRole')}
                  disabled={rolesLoading || rolesError}
                  onChange={event => { setFilterRole(event.target.value); setPage(1); }}
                >
                  <option value="">{rolesError ? t('users.form.optionsLoadError') : t('users.filters.allRoles')}</option>
                  {filterRoleOptions.map(role => (
                    <option key={role.id} value={role.name}>{translateRole(role.name)}</option>
                  ))}
                </select>
              </div>
              <div className="col-md-4">
                <label htmlFor="users-status-filter">{t('users.filters.statusLabel')}</label>
                <select
                  id="users-status-filter"
                  value={filterStatus}
                  aria-label={t('users.a11y.filterByStatus')}
                  onChange={event => { setFilterStatus(event.target.value); setPage(1); }}
                >
                  <option value="">{t('users.filters.allStatuses')}</option>
                  {['Active', 'Inactive', 'Suspended', 'Graduated', 'Locked'].map(status => (
                    <option key={status} value={status}>{translateStatus(status)}</option>
                  ))}
                </select>
              </div>
            </div>
            {(campusesError || rolesError) && (
              <button
                type="button"
                className="users-options-retry"
                onClick={() => {
                  if (campusesError) void refetchCampuses();
                  if (rolesError) void refetchRoles();
                }}
              >
                <RefreshCw aria-hidden="true" /> {t('users.retry')}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ======== TABLE CARD ======== */}
      <div className="users-table-card">
        <div className="users-table-header">
          <div>
            <h2>{t('users.table.title')}</h2>
          </div>
          <div className="users-table-header-actions">
            <div className="table-search-input">
              <Search aria-hidden="true" />
              <label className="visually-hidden" htmlFor="users-table-search">{t('users.a11y.searchUsers')}</label>
              <input
                id="users-table-search"
                type="text"
                placeholder={t('users.table.searchPlaceholder')}
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoComplete="off"
              />
            </div>
            {isAdmin && (
              <button type="button" className="bulk-import-btn"
                onClick={() => setBulkTeamsInviteOpen(true)}
                aria-haspopup="dialog">
                <FontAwesomeIcon icon={faChalkboardTeacher} aria-hidden="true" />
                {t('teacherInvitationBatch.openButton')}
              </button>
            )}
            {(isAdmin || isManager) && (
              <button type="button" className="bulk-import-btn users-export-btn"
                onClick={() => exportMutation.mutate()}
                disabled={exportMutation.isPending}
                aria-busy={exportMutation.isPending}
                title={t('users.export.hint')}>
                <Download aria-hidden="true" />
                <span role="status" aria-live="polite">
                  {t(exportMutation.isPending ? 'users.export.pending' : 'users.export.action')}
                </span>
              </button>
            )}
            {/* Admin, or Manager pinned server-side to their own school + Student/Teacher/Parent. */}
            {canCreateUsers && (
              <>
                <button type="button" className="bulk-import-btn" data-tour="users-bulk-import"
                  onClick={handleBulkImport} aria-label={t('users.a11y.bulkImport')}>
                  <LuImport aria-hidden="true" />
                  {t('users.actions.bulkImport')}
                </button>
                <button type="button" className="header-add-btn" data-tour="users-add"
                  onClick={openCreateModal} aria-label={t('users.a11y.addUser')}>
                  <i className="fas fa-plus" aria-hidden="true"></i> {t('users.actions.addUser')}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Selection bar (COM-721). Always mounted rather than appearing on first tick: a bar that
            pops in shifts the table down under the cursor mid-click. The send button is disabled
            when nothing is selected, per the ticket. */}
        {SHOW_SEND_INVITATIONS && (
          <div className="users-invite-bar">
            {/* Everything here reads selectedVisibleInviteIds, never the raw Set: the count, the
                enabled state and the payload must all mean "the rows on this screen". A refetch that
                shifts a row off the page would otherwise leave it armed and invisible, and the send
                would post an id the admin never reviewed. */}
            <span className="users-invite-count" role="status" aria-live="polite">
              {t('users.invitation.selectedCount', {
                count: selectedVisibleInviteIds.length,
                formattedCount: numberFormatter.format(selectedVisibleInviteIds.length),
              })}
            </span>
            {selectedVisibleInviteIds.length > 0 && (
              <button
                type="button"
                className="users-invite-clear"
                onClick={() => setSelectedInviteIds(new Set())}
              >
                {t('users.invitation.clearSelection')}
              </button>
            )}
            <button
              type="button"
              className="users-invite-send"
              disabled={selectedVisibleInviteIds.length === 0 || sendInvitationsMutation.isPending}
              onClick={() => handleSendInvitations(selectedVisibleInviteIds)}
            >
              <FontAwesomeIcon icon={faPaperPlane} aria-hidden="true" />
              {t('users.invitation.action')}
            </button>
          </div>
        )}

        {isFetching && data && (
          <div className="users-table-refresh" role="status" aria-live="polite">
            <RefreshCw aria-hidden="true" /> {t('users.table.refreshing')}
          </div>
        )}

        <div className="users-table-scroll" tabIndex={0} aria-label={t('users.a11y.usersTableScroll')}>
          <table className="users-table" aria-label={t('users.a11y.usersTable')}>
            <thead>
              <tr>
                {/* Select-all covers the CURRENT page only, with the filters left in effect —
                    the ticket's rule, and the honest one: an admin can only review what is on
                    screen. Not sortable, so it stays outside the sortable-column map. */}
                {SHOW_SEND_INVITATIONS && (
                  <th className="users-select-th">
                    <input
                      ref={selectAllInviteRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={visibleInviteIds.length === 0}
                      onChange={toggleSelectAllVisible}
                      aria-label={t('users.a11y.selectAllUsers')}
                    />
                  </th>
                )}
                {[
                  { key: 'fullName', label: t('users.table.user') },
                  { key: 'username', label: t('users.table.username') },
                  { key: 'role', label: t('users.table.role') },
                  { key: 'campus', label: t('users.table.campus') },
                  { key: 'status', label: t('users.table.status') },
                  { key: 'createdAt', label: t('users.table.created') },
                ].map(col => (
                  <th
                    key={col.key}
                    className={`sortable-th ${sortColumn === col.key ? 'active' : ''}`}
                    aria-sort={sortColumn === col.key ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button
                      type="button"
                      className="th-content"
                      onClick={() => handleSort(col.key)}
                      aria-label={t('users.a11y.sortColumn', { column: col.label })}
                    >
                      {col.label}
                      <span className="sort-arrows" aria-hidden="true">
                        <ChevronUp size={12} className={sortColumn === col.key && sortDirection === 'asc' ? 'active' : ''} />
                        <ChevronDown size={12} className={sortColumn === col.key && sortDirection === 'desc' ? 'active' : ''} />
                      </span>
                    </button>
                  </th>
                ))}
                <th>{t('users.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.length === 0 ? (
                <tr>
                  <td colSpan={SHOW_SEND_INVITATIONS ? 8 : 7}>
                    <div className="users-empty">
                      <Inbox aria-hidden="true" />
                      <h3>{t(hasActiveFilters ? 'users.table.emptyTitle' : 'users.table.emptyAllTitle')}</h3>
                      <p>{t(hasActiveFilters ? 'users.table.emptyText' : 'users.table.emptyAllText')}</p>
                      {/* A Manager with an empty unfiltered list gets no action here — the add
                          path is Admin's since Round 4, and a button that 403s is worse than none. */}
                      {(hasActiveFilters || isAdmin) && (
                        <button
                          type="button"
                          className="users-empty-action"
                          onClick={hasActiveFilters ? clearFilters : openCreateModal}
                        >
                          {t(hasActiveFilters ? 'users.filters.clear' : 'users.actions.addUser')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                visibleUsers.map(user => (
                  <tr key={user.id} className={selectedInviteIds.has(user.id) ? 'is-selected' : undefined}>
                    {SHOW_SEND_INVITATIONS && (
                      <td className="users-select-td">
                        <input
                          type="checkbox"
                          checked={selectedInviteIds.has(user.id)}
                          onChange={() => toggleInviteSelection(user.id)}
                          aria-label={t('users.a11y.selectUser', { name: user.fullName })}
                        />
                      </td>
                    )}
                    <td>
                      <div className="user-cell">
                        <div className={`user-avatar ${getRoleClass(user.roles)}`}>
                          {getInitials(user.fullName)}
                        </div>
                        <div className="user-info">
                          <div className="user-name">{user.fullName}</div>
                          <div className="user-email">{user.email}</div>
                        </div>
                      </div>
                    </td>
                    <td>{user.username}</td>
                    <td>
                      {user.roles.map(role => (
                        <span key={role} className={`role-badge ${role.toLowerCase()}`}>
                          {translateRole(role)}
                        </span>
                      ))}
                    </td>
                    <td>
                      <div className="org-campus-info">
                        {user.campusName ? (
                          <span className="campus-badge">{i18n.language === 'ar' && user.campusNameAr ? user.campusNameAr : user.campusName}</span>
                        ) : (
                          <span className="users-no-campus">{t('users.table.noCampus')}</span>
                        )}
                      </div>
                    </td>
                    <td>
                      <span className={`user-status-badge ${getEffectiveStatus(user).toLowerCase()}`}>
                        {translateStatus(getEffectiveStatus(user))}
                      </span>
                      {renderSsoBadge(user)}
                    </td>
                    <td className="users-created-date">
                      {formatDate(user.createdAt)}
                    </td>
                    <td>
                      <div className="user-table-actions">
                        <EqCardMenu
                          label={`${t('moreActions')} — ${user.fullName}`}
                          items={[
                            {
                              key: 'view',
                              icon: <FontAwesomeIcon icon={faEye} aria-hidden="true" />,
                              label: t('users.actions.view'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => setViewingUser(user),
                            },
                            {
                              key: 'edit',
                              icon: <FontAwesomeIcon icon={faEdit} aria-hidden="true" />,
                              label: t('users.actions.edit'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => openEditModal(user),
                            },
                            {
                              key: 'password',
                              icon: <FontAwesomeIcon icon={faKey} aria-hidden="true" />,
                              label: t('users.actions.resetPassword'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => handleResetPassword(user),
                            },
                            // Single-select: the same endpoint as the bulk bar, posting a list of
                            // one — so one row and thirty rows cannot behave differently.
                            ...(SHOW_SEND_INVITATIONS ? [{
                              key: 'invite',
                              icon: <FontAwesomeIcon icon={faPaperPlane} aria-hidden="true" />,
                              label: t('users.actions.sendInvitation'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => handleSendInvitations([user.id], user.fullName),
                            }] : []),
                            // Re-link — see canRelinkRole for which accounts qualify and why.
                            // Never on yourself either: re-pointing your own row at another identity
                            // is how an admin locks themselves out of their own account.
                            ...(currentUser?.id !== user.id
                              && user.roles.some(r => canRelinkRole(r, isAdmin)) ? [{
                              key: 'relink',
                              icon: <FontAwesomeIcon icon={faLink} aria-hidden="true" />,
                              label: t('users.actions.relinkAccount'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => openRelinkModal(user),
                            }] : []),
                            // A teacher's standing with the school's Microsoft tenant — what lets them
                            // host their own Teams lessons. Managers see it read-only; only an Admin
                            // gets the invite/resend/link/refresh actions (the server enforces both).
                            ...((isAdmin || isManager)
                              && user.roles.some(r => r.toLowerCase() === 'teacher') ? [{
                              key: 'microsoftAccount',
                              icon: <FontAwesomeIcon icon={faChalkboardTeacher} aria-hidden="true" />,
                              label: t('teacherMicrosoftAccount.menuItem'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => setMicrosoftAccountUser(user),
                            }] : []),
                            // Offered only for a retryable failure, and only to an Admin — the server
                            // (RequireAdminRole in UserService.cs) refuses a Manager caller outright.
                            // A CONFLICT deliberately gets no retry action — no number of attempts can
                            // make a foreign identity-provider account safe to adopt; that needs an
                            // administrator over there.
                            ...(isAdmin && user.keycloakSyncStatus === 'FAILED' ? [{
                              key: 'retrySso',
                              icon: <FontAwesomeIcon icon={faRotate} aria-hidden="true" />,
                              label: t('users.sso.retryTitle'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => handleRetrySso(user),
                            }] : []),
                            // Lock/Unlock — matching old project logic; never on yourself.
                            ...(currentUser?.id !== user.id && user.isLocked ? [{
                              key: 'unlock',
                              icon: <FontAwesomeIcon icon={faUnlock} aria-hidden="true" />,
                              label: t('users.actions.unlock'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => handleUnlockUser(user),
                            }] : []),
                            ...(currentUser?.id !== user.id && !user.isLocked && user.status === 'Active' ? [{
                              key: 'lock',
                              icon: <FontAwesomeIcon icon={faLock} aria-hidden="true" />,
                              label: t('users.actions.lock'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => handleLockUser(user),
                            }] : []),
                            // Suspend/Reactivate — matching old project; never on yourself.
                            ...(currentUser?.id !== user.id && user.status === 'Suspended' ? [{
                              key: 'reactivate',
                              icon: <FontAwesomeIcon icon={faCheck} aria-hidden="true" />,
                              label: t('users.actions.reactivate'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => handleReactivateUser(user),
                            }] : []),
                            ...(currentUser?.id !== user.id && user.status === 'Active' ? [{
                              key: 'suspend',
                              icon: <FontAwesomeIcon icon={faPause} aria-hidden="true" />,
                              label: t('users.actions.suspend'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => handleSuspendUser(user),
                            }] : []),
                            // Link Children — Parent role only. Open to a Manager too: the server
                            // narrows their modal and their writes to their own school.
                            ...(user.roles.some(r => r.toLowerCase() === 'parent') ? [{
                              key: 'linkChildren',
                              icon: <FontAwesomeIcon icon={faUsers} aria-hidden="true" />,
                              label: t('users.actions.linkChildren'),
                              disabled: isUserActionPending(user.id),
                              onSelect: () => handleLinkChildren(user),
                            }] : []),
                            ...(currentUser?.id !== user.id ? [{
                              key: 'delete',
                              icon: <FontAwesomeIcon icon={faTrash} aria-hidden="true" />,
                              label: t('users.actions.delete'),
                              danger: true,
                              disabled: isUserActionPending(user.id),
                              onSelect: () => handleDeleteUser(user),
                            }] : []),
                          ]}
                        />
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination — gate on the smallest page size, not totalPages: at pageSize 50 a
            short list collapses to one page and a totalPages gate would hide the bar,
            stranding the user with no way to switch the page size back. */}
        {listTotal > 10 && (
          <div className="users-pagination">
            <div className="users-pagination-info">
              {t('users.pagination.info', {
                start: numberFormatter.format(startItem),
                end: numberFormatter.format(endItem),
                total: numberFormatter.format(listTotal),
              })}
            </div>
            <div className="users-pagination-controls">
              <div className="page-size-select">
                {t('users.pagination.show')}
                <select aria-label={t('users.pagination.show')} value={pageSize} onChange={e => setPageSize(Number(e.target.value))}>
                  <option value={10}>10</option>
                  <option value={15}>15</option>
                  <option value={25}>25</option>
                  <option value={50}>50</option>
                </select>
                {t('users.pagination.entries')}
              </div>
              <div className="users-pagination-buttons">
                <button type="button" aria-label={t('users.a11y.previousPage')} disabled={page <= 1} onClick={() => setPage(page - 1)}>
                  {i18n.dir() === 'rtl' ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
                </button>
                {pageNumbers.map(p => (
                  <button type="button" key={p} className={p === page ? 'active' : ''}
                    aria-current={p === page ? 'page' : undefined}
                    aria-label={t(p === page ? 'users.a11y.currentPage' : 'users.a11y.pageNumber', { page: p })}
                    onClick={() => setPage(p)}>
                    {numberFormatter.format(p)}
                  </button>
                ))}
                <button type="button" aria-label={t('users.a11y.nextPage')} disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                  {i18n.dir() === 'rtl' ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ======== USER FORM MODAL (via Portal) ======== */}
      {/* Matching: SweetAlert modal in old project's manage-users.js */}
      {/* Uses createPortal to render at document.body (fixes z-index/stacking issues) */}
      {formModalOpen && createPortal(
        <div className="user-form-modal-overlay" dir={i18n.dir()} onClick={() => { if (!isSaving) closeFormModal(); }}>
          <div
            ref={formDialogRef}
            className="user-form-modal-card"
            data-tour="user-form"
            role="dialog"
            aria-modal="true"
            aria-labelledby="user-form-dialog-title"
            tabIndex={-1}
            onClick={e => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="user-form-modal-header">
              <h5 id="user-form-dialog-title">
                {editingUser
                  ? <><FontAwesomeIcon icon={faEdit} aria-hidden="true" /> {t('users.form.editTitle')}</>
                  : <><FontAwesomeIcon icon={faPlus} aria-hidden="true" /> {t('users.form.addTitle')}</>}
              </h5>
              <button type="button" className="user-form-modal-close" aria-label={t('users.a11y.closeDialog')}
                disabled={isSaving} onClick={closeFormModal}>&times;</button>
            </div>

            {/* Scrollable Form Body */}
            <form onSubmit={handleSubmit(onSubmit)}>
              <div className="user-form-modal-body">

                {/* Section 1: Personal Information */}
                <div className="form-section" data-tour="user-form-personal">
                  <h5 className="section-title">
                    <FontAwesomeIcon icon={faUserCircle} aria-hidden="true" />
                    {t('users.form.personalInformation')}
                  </h5>

                  <div className="row">
                    <div className="col-md-6 mb-3">
                      <label className="form-label required" htmlFor="user-full-name">{t('users.form.fullName')}</label>
                      <input
                        id="user-full-name"
                        type="text"
                        className={`form-control ${errors.fullName ? 'is-invalid' : (watchedFullName && watchedFullName.length >= 2) ? 'is-valid' : ''}`}
                        placeholder={t('users.form.fullNamePlaceholder')}
                        maxLength={100}
                        aria-invalid={Boolean(errors.fullName)}
                        aria-describedby={errors.fullName ? 'user-full-name-error' : undefined}
                        {...register('fullName')}
                      />
                      {errors.fullName && <div id="user-full-name-error" className="invalid-feedback">{errors.fullName.message}</div>}
                      <div className="char-counter">{numberFormatter.format((watchedFullName || '').length)}/{numberFormatter.format(100)}</div>
                    </div>
                    <div className="col-md-6 mb-3">
                      <label className="form-label required" htmlFor="user-username">{t('users.form.username')}</label>
                      <input
                        id="user-username"
                        type="text"
                        className={`form-control ${errors.username ? 'is-invalid' : (watchedUsername && watchedUsername.length >= 3) ? 'is-valid' : ''}`}
                        placeholder={t('users.form.usernamePlaceholder')}
                        readOnly={!!editingUser}
                        maxLength={50}
                        aria-invalid={Boolean(errors.username)}
                        aria-describedby={errors.username ? 'user-username-error' : undefined}
                        {...register('username')}
                      />
                      {errors.username && <div id="user-username-error" className="invalid-feedback">{errors.username.message}</div>}
                      <div className="char-counter">{numberFormatter.format((watchedUsername || '').length)}/{numberFormatter.format(50)}</div>
                    </div>
                  </div>

                  <div className="row">
                    <div className="col-md-6 mb-3">
                      <label className="form-label required" htmlFor="user-email">{t('users.form.email')}</label>
                      <input
                        id="user-email"
                        type="email"
                        className={`form-control ${errors.email ? 'is-invalid' : (watchedEmail && EMAIL_PATTERN.test(watchedEmail)) ? 'is-valid' : ''}`}
                        placeholder={t('users.form.emailPlaceholder')}
                        // Changing an address is not a profile edit — it decides which Tuwaiq
                        // account signs in as this person. It lives in the re-link action, which
                        // searches the platform first. The server refuses a changed email here.
                        readOnly={!!editingUser}
                        aria-invalid={Boolean(errors.email)}
                        aria-describedby={errors.email ? 'user-email-error' : undefined}
                        {...register('email')}
                      />
                      {errors.email && <div id="user-email-error" className="invalid-feedback">{errors.email.message}</div>}
                    </div>
                    <div className="col-md-6 mb-3">
                      <label className="form-label" htmlFor="user-phone">{t('users.form.phone')}</label>
                      <input
                        id="user-phone"
                        type="text"
                        className={`form-control ${errors.phone ? 'is-invalid' : (watchedPhone && /^\+?[0-9][0-9\s-]{6,18}$/.test(watchedPhone)) ? 'is-valid' : ''}`}
                        inputMode="tel"
                        placeholder={t('users.form.phonePlaceholder')}
                        maxLength={20}
                        aria-invalid={Boolean(errors.phone)}
                        aria-describedby={errors.phone ? 'user-phone-error' : undefined}
                        {...register('phone')}
                      />
                      {errors.phone && <div id="user-phone-error" className="invalid-feedback">{errors.phone.message}</div>}
                      <div className="char-counter">{numberFormatter.format((watchedPhone || '').length)}/{numberFormatter.format(20)}</div>
                    </div>
                  </div>

                  <div className="row">
                    <div className="col-md-6 mb-3">
                      <label className={`form-label${editingUser ? '' : ' required'}`} htmlFor="user-national-id">{t('users.form.nationalId')}</label>
                      <input
                        id="user-national-id"
                        type="text"
                        className={`form-control ${errors.nationalId ? 'is-invalid' : (watchedNationalId && /^[12][0-9]{9}$/.test(watchedNationalId)) ? 'is-valid' : ''}`}
                        inputMode="numeric"
                        placeholder={t('users.form.nationalIdPlaceholder')}
                        maxLength={10}
                        aria-invalid={Boolean(errors.nationalId)}
                        aria-describedby={errors.nationalId ? 'user-national-id-error' : undefined}
                        {...register('nationalId')}
                      />
                      {errors.nationalId && <div id="user-national-id-error" className="invalid-feedback">{errors.nationalId.message}</div>}
                      <div className="char-counter">{numberFormatter.format((watchedNationalId || '').length)}/{numberFormatter.format(10)}</div>
                    </div>
                  </div>

                  <div className="row">
                    <div className="col-md-6 mb-3">
                      <label className="form-label" htmlFor="user-date-of-birth">{t('users.form.dateOfBirth')}</label>
                      <Controller
                        name="dateOfBirth"
                        control={control}
                        render={({ field }) => (
                          <Flatpickr
                            id="user-date-of-birth"
                            className="form-control"
                            placeholder={t('users.form.dateOfBirthPlaceholder')}
                            value={field.value || ''}
                            options={{
                              dateFormat: 'Y-m-d',
                              maxDate: 'today',
                              minDate: '1930-01-01',
                              allowInput: true,
                              monthSelectorType: 'static',
                            }}
                            onChange={([date]) => {
                              if (date) {
                                const y = date.getFullYear();
                                const m = String(date.getMonth() + 1).padStart(2, '0');
                                const d = String(date.getDate()).padStart(2, '0');
                                field.onChange(`${y}-${m}-${d}`);
                              } else {
                                field.onChange('');
                              }
                            }}
                          />
                        )}
                      />
                    </div>
                    <div className="col-md-6 mb-3">
                      <fieldset className="users-fieldset">
                      <legend className="form-label">{t('users.form.gender')}</legend>
                      <div className="d-flex gap-3" role="radiogroup">
                        <label className={`selection-card gender-card ${selectedGender === 'Male' ? 'selected' : ''}`}>
                          <input type="radio" value="Male" {...register('gender')} />
                          <FontAwesomeIcon icon={faMale} className="selection-icon-fa male" aria-hidden="true" />
                          <span>{t('users.enums.genders.male')}</span>
                        </label>
                        <label className={`selection-card gender-card ${selectedGender === 'Female' ? 'selected' : ''}`}>
                          <input type="radio" value="Female" {...register('gender')} />
                          <FontAwesomeIcon icon={faFemale} className="selection-icon-fa female" aria-hidden="true" />
                          <span>{t('users.enums.genders.female')}</span>
                        </label>
                      </div>
                      </fieldset>
                    </div>
                  </div>
                </div>

                {/* Section 2: Security Settings (create mode only) — no password inputs since the
                    credential rework: the server generates a temporary password and emails it to
                    the user, so the admin has nothing to type and nothing to know. */}
                {!editingUser && (
                  <div className="form-section" data-tour="user-form-security">
                    <h5 className="section-title">
                      <FontAwesomeIcon icon={faShieldAlt} aria-hidden="true" />
                      {t('users.form.securitySettings')}
                    </h5>

                    <p className="users-field-hint" role="note">
                      <FontAwesomeIcon icon={faEnvelope} aria-hidden="true" />{' '}
                      {t('users.form.tempPasswordNote')}
                    </p>
                  </div>
                )}

                {/* Section 3: Account Configuration */}
                <div className="form-section" data-tour="user-form-account">
                  <h5 className="section-title">
                    <FontAwesomeIcon icon={faCog} aria-hidden="true" />
                    {t('users.form.accountConfiguration')}
                  </h5>
                  {isEditingSelf && (
                    <p className="users-field-hint" role="note">
                      {t('users.form.selfEditSensitiveHint', {
                        defaultValue: i18n.language === 'ar'
                          ? 'لأمان حسابك، لن تتغير المدرسة والأدوار والشُعب الدراسية والحالة من هنا.'
                          : 'For your security, school, roles, groups, and status will not change here.',
                      })}
                    </p>
                  )}

                  <div className="row">
                    <div className="col-md-6 mb-3">
                      <label className="form-label" htmlFor="user-campus">{t('users.form.campus')}</label>
                      <select id="user-campus" className="form-select"
                        {...register('campusId', {
                          onChange: () => {
                            setValue('groupIds', [], { shouldDirty: true });
                            clearErrors('groupIds');
                          },
                        })}
                        disabled={campusesLoading || campusesError || isEditingSelf || !isAdmin}>
                        <option value="">
                          {campusesLoading
                            ? t('users.form.loadingCampuses')
                            : campusesError
                              ? t('users.form.optionsLoadError')
                              : t('users.form.selectCampus')}
                        </option>
                        {formCampusOptions.map(c => (
                          <option key={c.id} value={c.id}>{campusOptionLabel(c)}</option>
                        ))}
                      </select>
                      {campusesError && (
                        <button
                          type="button"
                          className="users-options-retry"
                          onClick={() => void refetchCampuses()}
                        >
                          <RefreshCw aria-hidden="true" /> {t('users.retry')}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* New users receive one role. Editing preserves legacy multi-role accounts. */}
                  <div className="row mb-3">
                    <div className="col-12">
                      <fieldset className="users-fieldset" data-tour="user-roles" disabled={isEditingSelf}>
                      <legend className="form-label required">{t('users.form.userRoles')}</legend>
                      <p className="users-field-hint">{t('users.form.rolesHint')}</p>
                      {errors.roleIds && (
                        <div className="text-danger users-field-error" role="alert">
                          {errors.roleIds.message}
                        </div>
                      )}
                      {rolesLoading ? (
                        <div className="text-muted users-option-state" role="status">
                          {t('users.form.loadingRoles')}
                        </div>
                      ) : rolesError ? (
                        <button type="button" className="users-inline-retry" onClick={() => void refetchRoles()}>
                          <RefreshCw aria-hidden="true" /> {t('users.retry')}
                        </button>
                      ) : (
                        <div className="d-flex gap-2 flex-wrap">
                          {formRoleOptions.map(role => {
                            const roleIcon = getRoleIcon(role.name);
                            const isSelected = selectedRoleIds.includes(role.id);
                            return (
                              <label
                                key={role.id}
                                className={`selection-card role-card ${isSelected ? 'selected' : ''}`}
                              >
                                <input
                                  type="radio"
                                  name="user-role"
                                  checked={isSelected}
                                  aria-label={t('users.a11y.selectRole', { role: translateRole(role.name) })}
                                  onChange={() => toggleRole(role.id)}
                                />
                                <FontAwesomeIcon icon={roleIcon} className="selection-icon-fa" aria-hidden="true" />
                                <span>{translateRole(role.name)}</span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                      </fieldset>
                    </div>
                  </div>

                  {/* Groups — shown when Student/Teacher is selected and campus is chosen */}
                  {hasStudentOrTeacherRole && (
                    <div className="row mb-3" data-tour="user-groups">
                      <div className="col-12">
                        <label className="form-label required" htmlFor="user-groups">{t('users.form.groups')}</label>
                        {!watchedCampusId || Number(watchedCampusId) === 0 ? (
                          <p className="text-muted users-field-hint">{t('users.form.selectCampusFirst')}</p>
                        ) : groupsLoading ? (
                          <p className="text-muted users-option-state" role="status">{t('users.form.groupsLoading')}</p>
                        ) : groupsError ? (
                          <button type="button" className="users-inline-retry" onClick={() => void refetchGroups()}>
                            <RefreshCw aria-hidden="true" /> {t('users.form.groupsLoadError')}
                          </button>
                        ) : (
                          <>
                            <select
                              id="user-groups"
                              className="form-select"
                              multiple
                              size={4}
                              value={selectedGroupIds.map(String)}
                              disabled={isEditingSelf}
                              aria-invalid={Boolean(errors.groupIds)}
                              aria-describedby={errors.groupIds ? 'user-groups-error' : 'user-groups-hint'}
                              onChange={e => {
                                const selected = Array.from(e.target.selectedOptions, opt => Number(opt.value));
                                setValue('groupIds', selected, { shouldDirty: true, shouldValidate: true });
                                if (selected.length) clearErrors('groupIds');
                              }}
                            >
                              {formGroupOptions.length === 0 ? (
                                <option disabled>{t('users.form.noGroups')}</option>
                              ) : (
                                formGroupOptions.map(g => (
                                  <option key={g.id} value={g.id}>
                                    {g.code} - {g.name}
                                  </option>
                                ))
                              )}
                            </select>
                            <small id="user-groups-hint" className="text-muted">{t('users.form.multipleGroupsHint')}</small>
                            {errors.groupIds && <div id="user-groups-error" className="text-danger users-field-error">{errors.groupIds.message}</div>}
                          </>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Status Selection Cards — interactive, matching old project.
                      Graduated is server-derived (the group graduation flow): the card appears
                      only when the account already holds it, and only an Admin may move the
                      account out of it — for a Manager the whole fieldset locks so a profile
                      edit can never silently un-graduate a student (the server enforces the
                      same rule; this just makes the UI honest about it). */}
                  {editingUser ? <div className="row">
                    <div className="col-12">
                      <fieldset
                        className="users-fieldset"
                        disabled={isEditingSelf || (editingUser.status === 'Graduated' && !isAdmin)}
                      >
                      <legend className="form-label">{t('users.form.accountStatus')}</legend>
                      <div className="d-flex gap-2 flex-wrap">
                        {editingUser.status === 'Graduated' && (
                          <button type="button"
                            className={`selection-card status-card ${selectedStatus === 'Graduated' ? 'selected' : ''}`}
                            aria-pressed={selectedStatus === 'Graduated'}
                            onClick={() => setValue('status', 'Graduated', { shouldDirty: true })}
                          >
                            <FontAwesomeIcon icon={faUserGraduate} className="selection-icon-fa active-icon" aria-hidden="true" />
                            <span>{t('users.enums.statuses.graduated')}</span>
                          </button>
                        )}
                        <button type="button"
                          className={`selection-card status-card ${selectedStatus === 'Active' ? 'selected' : ''}`}
                          aria-pressed={selectedStatus === 'Active'}
                          onClick={() => setValue('status', 'Active', { shouldDirty: true })}
                        >
                          <FontAwesomeIcon icon={faCheckCircle} className="selection-icon-fa active-icon" aria-hidden="true" />
                          <span>{t('users.enums.statuses.active')}</span>
                        </button>
                        <button type="button"
                          className={`selection-card status-card ${selectedStatus === 'Inactive' ? 'selected' : ''}`}
                          aria-pressed={selectedStatus === 'Inactive'}
                          onClick={() => setValue('status', 'Inactive', { shouldDirty: true })}
                        >
                          <FontAwesomeIcon icon={faPauseCircle} className="selection-icon-fa warning-icon" aria-hidden="true" />
                          <span>{t('users.enums.statuses.inactive')}</span>
                        </button>
                        <button type="button"
                          className={`selection-card status-card ${selectedStatus === 'Suspended' ? 'selected' : ''}`}
                          aria-pressed={selectedStatus === 'Suspended'}
                          onClick={() => setValue('status', 'Suspended', { shouldDirty: true })}
                        >
                          <FontAwesomeIcon icon={faBan} className="selection-icon-fa danger-icon" aria-hidden="true" />
                          <span>{t('users.enums.statuses.suspended')}</span>
                        </button>
                      </div>
                      </fieldset>
                    </div>
                  </div> : <p className="users-field-hint">{t('users.form.newUserStatusHint')}</p>}
                </div>

                {/* Section 4: Regional Preferences — matching old project */}
                <div className="form-section" data-tour="user-form-regional">
                  <h5 className="section-title">
                    <FontAwesomeIcon icon={faGlobe} aria-hidden="true" />
                    {t('users.form.regionalPreferences')}
                  </h5>

                  <div className="row">
                    <div className="col-md-6 mb-3">
                      <label className="form-label" htmlFor="user-language">{t('users.form.preferredLanguage')}</label>
                      <select id="user-language" className="form-select" {...register('preferredLanguage')}>
                        <option value="ar">{t('users.enums.languages.arabic')}</option>
                        <option value="en">{t('users.enums.languages.english')}</option>
                      </select>
                    </div>
                    <div className="col-md-6 mb-3">
                      <label className="form-label" htmlFor="user-time-zone">{t('users.form.timeZone')}</label>
                      <select id="user-time-zone" className="form-select" {...register('timeZone')}>
                        <option value="Arab Standard Time">{t('users.enums.timeZones.arabStandard')}</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>

              {/* Modal Footer — matching SweetAlert confirm/cancel */}
              <div className="user-form-modal-footer" data-tour="user-form-save">
                <button type="button" className="btn-cancel" onClick={closeFormModal} disabled={isSaving}>
                  {t('users.form.cancel')}
                </button>
                <button type="submit" className="btn-save" disabled={isSaving}>
                  {isSaving ? t('users.form.saving') : t('users.form.save')}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* ======== BULK IMPORT MODAL (same shell as Add/Edit) ======== */}
      {bulkModalOpen && createPortal(
        <div className="user-form-modal-overlay" dir={i18n.dir()} onClick={closeBulkImportModal}>
          <div
            ref={bulkDialogRef}
            className="user-form-modal-card bulk-import-modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-import-dialog-title"
            tabIndex={-1}
            onClick={event => event.stopPropagation()}
          >
            <div className="user-form-modal-header">
              <h5 id="bulk-import-dialog-title">
                <LuImport aria-hidden="true" /> {t('users.bulk.title')}
              </h5>
              <button
                type="button"
                className="user-form-modal-close"
                aria-label={t('users.a11y.closeDialog')}
                disabled={bulkSubmitting}
                onClick={closeBulkImportModal}
              >
                &times;
              </button>
            </div>

            <form onSubmit={submitBulkImport}>
              <div className="user-form-modal-body bulk-import-modal-body">
                <p className="users-field-hint mb-3">{t('users.bulk.subtitle')}</p>
                <div className="bulk-import-grid">
                  <section className="form-section bulk-import-section" data-tour="users-bulk-settings">
                    <h5 className="section-title">
                      <Shield aria-hidden="true" /> {t('users.bulk.globalSettings')}
                    </h5>

                    <div className="mb-3">
                      <label className="form-label" htmlFor="bulk-campus">{t('users.bulk.campus')}</label>
                      <select
                        id="bulk-campus"
                        className="form-select"
                        value={bulkCampusId}
                        disabled={campusesLoading || campusesError || !isAdmin}
                        onChange={event => {
                          setBulkCampusId(event.target.value);
                          setBulkGroupIds([]);
                          setBulkValidationError(null);
                        }}
                      >
                        <option value="">
                          {campusesLoading
                            ? t('users.form.loadingCampuses')
                            : campusesError
                              ? t('users.form.optionsLoadError')
                              : t('users.bulk.selectCampus')}
                        </option>
                        {activeCampuses.map(campus => (
                          <option key={campus.id} value={campus.id}>{campusOptionLabel(campus)}</option>
                        ))}
                      </select>
                      {campusesError && (
                        <button
                          type="button"
                          className="users-options-retry"
                          onClick={() => void refetchCampuses()}
                        >
                          <RefreshCw aria-hidden="true" /> {t('users.retry')}
                        </button>
                      )}
                    </div>

                    <fieldset className="users-fieldset mb-3">
                      <legend className="form-label">{t('users.bulk.role')}</legend>
                      <div className="bulk-role-options bulk-role-options-three">
                        <button
                          type="button"
                          className={`selection-card role-card ${bulkRole === 'Student' ? 'selected' : ''}`}
                          aria-pressed={bulkRole === 'Student'}
                          onClick={() => { setBulkRole('Student'); setBulkValidationError(null); }}
                        >
                          <FontAwesomeIcon icon={faUserGraduate} className="selection-icon-fa" aria-hidden="true" />
                          <span>{t('users.bulk.student')}</span>
                        </button>
                        <button
                          type="button"
                          className={`selection-card role-card ${bulkRole === 'Teacher' ? 'selected' : ''}`}
                          aria-pressed={bulkRole === 'Teacher'}
                          onClick={() => { setBulkRole('Teacher'); setBulkValidationError(null); }}
                        >
                          <FontAwesomeIcon icon={faChalkboardTeacher} className="selection-icon-fa" aria-hidden="true" />
                          <span>{t('users.bulk.teacher')}</span>
                        </button>
                        <button type="button"
                          className={`selection-card role-card ${bulkRole === 'Parent' ? 'selected' : ''}`}
                          aria-pressed={bulkRole === 'Parent'}
                          onClick={() => { setBulkRole('Parent'); setBulkGroupIds([]); setBulkValidationError(null); }}>
                          <FontAwesomeIcon icon={faUsers} className="selection-icon-fa" aria-hidden="true" />
                          <span>{t('users.enums.roles.parent')}</span>
                        </button>
                      </div>
                    </fieldset>

                    {bulkRole && bulkRole !== 'Parent' && (
                      <div className="mb-3">
                        <label className="form-label" htmlFor="bulk-groups">{t('users.bulk.groups')}</label>
                        <select
                          id="bulk-groups"
                          className="form-select"
                          multiple
                          size={4}
                          value={bulkGroupIds.map(String)}
                          disabled={!bulkCampusId || bulkGroupsLoading || bulkGroupsError}
                          onChange={event => {
                            setBulkGroupIds(Array.from(event.currentTarget.selectedOptions, option => Number(option.value)));
                            setBulkValidationError(null);
                          }}
                        >
                          {!bulkCampusId && <option disabled value="">{t('users.bulk.selectCampusFirst')}</option>}
                          {bulkCampusId && bulkGroupsLoading && <option disabled value="">{t('users.bulk.loadingGroups')}</option>}
                          {bulkCampusId && bulkGroupsError && <option disabled value="">{t('users.bulk.groupsLoadError')}</option>}
                          {bulkCampusId && !bulkGroupsLoading && !bulkGroupsError && bulkGroups.length === 0 && (
                            <option disabled value="">{t('users.bulk.noGroups')}</option>
                          )}
                          {bulkGroups.map(group => (
                            <option key={group.id} value={group.id}>{group.code} - {group.name}</option>
                          ))}
                        </select>
                        <div className="users-field-hint">{t('users.bulk.multipleGroupsHint')}</div>
                        {bulkGroupsError && (
                          <button type="button" className="users-options-retry mt-2" onClick={() => void refetchBulkGroups()}>
                            <RefreshCw aria-hidden="true" /> {t('users.retry')}
                          </button>
                        )}
                      </div>
                    )}

                    <fieldset className="users-fieldset mb-3">
                      <legend className="form-label">{t('users.bulk.status')}</legend>
                      <div className="bulk-role-options">
                        <button
                          type="button"
                          className={`selection-card status-card ${bulkStatus === 'Active' ? 'selected' : ''}`}
                          aria-pressed={bulkStatus === 'Active'}
                          onClick={() => setBulkStatus('Active')}
                        >
                          <FontAwesomeIcon icon={faCheckCircle} className="selection-icon-fa active-icon" aria-hidden="true" />
                          <span>{t('users.bulk.active')}</span>
                        </button>
                        <button
                          type="button"
                          className={`selection-card status-card ${bulkStatus === 'Inactive' ? 'selected' : ''}`}
                          aria-pressed={bulkStatus === 'Inactive'}
                          onClick={() => setBulkStatus('Inactive')}
                        >
                          <FontAwesomeIcon icon={faPauseCircle} className="selection-icon-fa warning-icon" aria-hidden="true" />
                          <span>{t('users.bulk.inactive')}</span>
                        </button>
                      </div>
                    </fieldset>

                  </section>

                  <section className="form-section bulk-import-section" data-tour="users-bulk-file">
                    <h5 className="section-title">
                      <LuImport aria-hidden="true" /> {t('users.bulk.fileUpload')}
                    </h5>

                    <div className="bi-template-card">
                      <div className="bi-template-icon"><i className="fas fa-file-excel" aria-hidden="true"></i></div>
                      <div className="bi-template-info">
                        <h6>{t('users.bulk.csvTemplate')}</h6>
                        <p id="bulk-template-description">
                          {t(!bulkRole ? 'users.bulk.templateChooseRole' : bulkRole === 'Parent' ? 'users.bulk.parentTemplateDescription' : 'users.bulk.templateDescription')}
                        </p>
                      </div>
                      <button
                        type="button"
                        className="bulk-template-action"
                        disabled={!bulkRole}
                        aria-describedby="bulk-template-description"
                        onClick={() => void downloadBulkImportTemplate()}
                      >
                        <i className="fas fa-download" aria-hidden="true"></i> {t('users.bulk.download')}
                      </button>
                    </div>

                    <input
                      ref={bulkFileInputRef}
                      type="file"
                      accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.csv,text/csv"
                      className="visually-hidden"
                      tabIndex={-1}
                      onChange={event => selectBulkFile(event.target.files?.[0] ?? null)}
                    />
                    <button
                      type="button"
                      className={`bulk-file-dropzone ${bulkDragActive ? 'is-dragging' : ''} ${bulkFile ? 'has-file' : ''}`}
                      aria-label={t('users.a11y.uploadCsv')}
                      onClick={() => bulkFileInputRef.current?.click()}
                      onDragEnter={event => { event.preventDefault(); setBulkDragActive(true); }}
                      onDragOver={event => { event.preventDefault(); setBulkDragActive(true); }}
                      onDragLeave={event => {
                        event.preventDefault();
                        setBulkDragActive(false);
                      }}
                      onDrop={event => {
                        event.preventDefault();
                        selectBulkFile(event.dataTransfer.files?.[0] ?? null);
                      }}
                    >
                      <LuImport aria-hidden="true" />
                      <strong>{t('users.bulk.dropzoneTitle')}</strong>
                      <span>{t('users.bulk.dropzoneHint')}</span>
                    </button>

                    {bulkFile && (
                      <div className="bulk-file-summary" role="status">
                        <LuImport aria-hidden="true" />
                        <div>
                          <strong>{bulkFile.name}</strong>
                          <span>{t('users.bulk.fileSize', { size: numberFormatter.format(Number((bulkFile.size / 1024).toFixed(1))) })}</span>
                        </div>
                      </div>
                    )}

                    <div className="bi-format-hint">
                      <i className="fas fa-lightbulb" aria-hidden="true"></i>
                      {t('users.bulk.csvFormatLabel')} <code>{bulkRole === 'Parent' ? 'Full Name · National ID · Email · Phone · Student National ID' : t('users.bulk.csvFormatValue')}</code><br />
                      {t('users.bulk.csvDelimiterHint')}
                    </div>
                  </section>
                </div>

                {bulkValidationError && (
                  <div className="bulk-validation-error" role="alert" aria-live="polite">
                    {bulkValidationError}
                  </div>
                )}
              </div>

              <div className="user-form-modal-footer">
                <button type="button" className="btn-cancel" onClick={closeBulkImportModal} disabled={bulkSubmitting}>
                  {t('users.bulk.cancel')}
                </button>
                <button type="submit" className="btn-save" disabled={bulkSubmitting}>
                  {bulkSubmitting ? t('users.bulk.processingTitle') : t('users.bulk.process')}
                </button>
              </div>
            </form>
          </div>
        </div>,
        document.body
      )}

      {/* ======== VIEW USER MODAL (via Portal) ======== */}
      {/* Matching: viewUser() SweetAlert in old project */}
      {viewingUser && createPortal(
        <div className="view-user-modal-overlay" dir={i18n.dir()} onClick={() => setViewingUser(null)}>
          <div ref={viewDialogRef} className="view-user-modal-card users-view-modal-card" data-tour="user-view-modal"
            role="dialog" aria-modal="true"
            aria-labelledby="view-user-dialog-title" tabIndex={-1} onClick={e => e.stopPropagation()}>
            {/* Shared branded header */}
            <div className="view-user-header">
              <div className="view-user-icon">
                <User size={30} aria-hidden="true" />
              </div>
              <div className="view-user-header-info">
                <h2 id="view-user-dialog-title" className="view-user-name">{viewingUser.fullName}</h2>
                <p className="view-user-email">{viewingUser.email}</p>
                <div className="view-user-badges">
                  {viewingUser.roles.map(r => (
                    <span key={r} className="view-role-badge">{translateRole(r)}</span>
                  ))}
                  <span className={`view-status-badge ${getEffectiveStatus(viewingUser).toLowerCase()}`}>
                    {translateStatus(getEffectiveStatus(viewingUser))}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="user-form-modal-close"
                aria-label={t('users.a11y.closeDialog')}
                onClick={() => setViewingUser(null)}
              >
                &times;
              </button>
            </div>

            {/* Detail cards — 3-column grid matching old project */}
            <div className="view-user-body users-view-modal-body">
              <div className="detail-grid">
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><User size={14} /></div>
                    <span className="detail-card-label">{t('users.details.username')}</span>
                  </div>
                  <div className="detail-card-value">{viewingUser.username}</div>
                </div>
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><Phone size={14} /></div>
                    <span className="detail-card-label">{t('users.details.phone')}</span>
                  </div>
                  <div className="detail-card-value">{viewingUser.phone || t('users.details.notProvided')}</div>
                </div>
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><CreditCard size={14} /></div>
                    <span className="detail-card-label">{t('users.details.nationalId')}</span>
                  </div>
                  <div className="detail-card-value">{viewingUser.nationalId || t('users.details.notProvided')}</div>
                </div>
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><Calendar size={14} /></div>
                    <span className="detail-card-label">{t('users.details.dateOfBirth')}</span>
                  </div>
                  <div className="detail-card-value">
                    {viewingUser.dateOfBirth
                      ? formatDate(viewingUser.dateOfBirth)
                      : t('users.details.notProvided')}
                  </div>
                </div>
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><User size={14} /></div>
                    <span className="detail-card-label">{t('users.details.gender')}</span>
                  </div>
                  <div className="detail-card-value">{viewingUser.gender ? translateGender(viewingUser.gender) : t('users.details.notSpecified')}</div>
                </div>
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><MapPin size={14} /></div>
                    <span className="detail-card-label">{t('users.details.campus')}</span>
                  </div>
                  <div className="detail-card-value">{(i18n.language === 'ar' && viewingUser.campusNameAr ? viewingUser.campusNameAr : viewingUser.campusName) || t('users.details.notAssigned')}</div>
                </div>
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><Shield size={14} /></div>
                    <span className="detail-card-label">{t('users.details.accountStatus')}</span>
                  </div>
                  <div className="detail-card-value">{translateStatus(getEffectiveStatus(viewingUser))}</div>
                </div>
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><Globe size={14} /></div>
                    <span className="detail-card-label">{t('users.details.language')}</span>
                  </div>
                  <div className="detail-card-value">
                    {viewingUser.preferredLanguage === 'ar'
                      ? t('users.enums.languages.arabic')
                      : t('users.enums.languages.english')}
                  </div>
                </div>
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><Clock size={14} /></div>
                    <span className="detail-card-label">{t('users.details.timeZone')}</span>
                  </div>
                  <div className="detail-card-value">{viewingUser.timeZone}</div>
                </div>
                {viewingUser.groups && viewingUser.groups.length > 0 && (
                  <div className="detail-card">
                    <div className="detail-card-header">
                      <div className="detail-card-icon"><Users size={14} /></div>
                      <span className="detail-card-label">{t('users.details.groups')}</span>
                    </div>
                    <div className="detail-card-value">
                      {viewingUser.groups.map(formatUserGroup).join(', ')}
                    </div>
                  </div>
                )}
                <div className="detail-card">
                  <div className="detail-card-header">
                    <div className="detail-card-icon"><Calendar size={14} /></div>
                    <span className="detail-card-label">{t('users.details.createdDate')}</span>
                  </div>
                  <div className="detail-card-value">{formatDate(viewingUser.createdAt)}</div>
                </div>
              </div>
            </div>

            <div className="view-user-footer users-view-modal-footer">
              <button type="button" className="view-user-close" onClick={() => setViewingUser(null)}>
                {t('users.details.close')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ======== LINK CHILDREN MODAL (matching old project: two-column layout) ======== */}
      {linkChildrenUser && createPortal(
        <div className="user-form-modal-overlay" dir={i18n.dir()} onClick={closeLinkChildrenModal}>
          <div ref={childrenDialogRef} className="user-form-modal-card link-children-modal-card" data-tour="user-children-modal"
            role="dialog" aria-modal="true"
            aria-labelledby="link-children-dialog-title" aria-busy={linkChildrenLoading || linkChildrenSaving}
            tabIndex={-1} onClick={e => e.stopPropagation()}>
            {/* Modal Header */}
            <div className="user-form-modal-header link-children-header">
              <div>
                <h5 id="link-children-dialog-title"><FontAwesomeIcon icon={faUsers} aria-hidden="true" />{t('users.linkChildren.title')}</h5>
                <p>{t('users.linkChildren.subtitle')}</p>
              </div>
              <button type="button" className="user-form-modal-close" aria-label={t('users.a11y.closeDialog')}
                disabled={linkChildrenSaving} onClick={closeLinkChildrenModal}>&times;</button>
            </div>

            {linkChildrenLoading ? (
              <div className="link-children-loading" role="status" aria-live="polite">
                <div className="link-children-skeleton" aria-hidden="true">
                  <span /><span /><span /><span />
                </div>
                <p>{t('users.linkChildren.loading')}</p>
              </div>
            ) : linkChildrenData ? (
              <div className="link-children-content">
                {/* Parent Info Banner */}
                <div className="parent-info-banner">
                  <div className="parent-avatar-lg">
                    <FontAwesomeIcon icon={faUserCircle} aria-hidden="true" />
                  </div>
                  <div className="parent-details">
                    <h5>{linkChildrenData.parentName}</h5>
                    <span><FontAwesomeIcon icon={faEnvelope} className="parent-email-icon" aria-hidden="true" />{linkChildrenData.parentEmail}</span>
                  </div>
                </div>

                {/* Two-column layout */}
                <div className="link-children-body">
                  <div className="row g-4">
                    {/* Left: Linked Children */}
                    <div className="col-md-6">
                      <div className="children-section">
                        <div className="section-header linked">
                          <FontAwesomeIcon icon={faLink} aria-hidden="true" />
                          <span>{t('users.linkChildren.linkedChildren')}</span>
                          <span className="badge-count">{numberFormatter.format(linkChildrenData.linkedChildren.length)}</span>
                        </div>
                        <div className="search-box">
                          <input type="text" aria-label={t('users.linkChildren.searchLinkedPlaceholder')}
                            placeholder={t('users.linkChildren.searchLinkedPlaceholder')} value={linkedSearch}
                            onChange={e => setLinkedSearch(e.target.value)} autoComplete="off" />
                        </div>
                        <div className="children-list">
                          {linkChildrenData.linkedChildren
                            .filter(c => !linkedSearch || c.fullName.toLowerCase().includes(linkedSearch.toLowerCase()) || (c.email?.toLowerCase().includes(linkedSearch.toLowerCase())))
                            .map(child => (
                              <label key={child.id} className={`child-item ${selectedLinkedIds.has(child.id) ? 'selected' : ''}`}>
                                <input type="checkbox" checked={selectedLinkedIds.has(child.id)}
                                  aria-label={t('users.a11y.linkedChild', { name: child.fullName })}
                                  disabled={linkChildrenSaving} onChange={() => toggleLinkedId(child.id)} />
                                <div className="child-info">
                                  <div className="child-name">{child.fullName}</div>
                                  <div className="child-email">{child.email}</div>
                                </div>
                                {child.groupName && <span className="child-group">{child.groupName}</span>}
                              </label>
                            ))}
                          {linkChildrenData.linkedChildren.length === 0 && (
                            <div className="empty-state-children">
                              <FontAwesomeIcon icon={faLink} className="empty-state-children-icon" aria-hidden="true" />
                              <p>{t('users.linkChildren.noLinkedChildren')}</p>
                            </div>
                          )}
                        </div>
                        <div className="section-footer">
                          <button type="button" className="btn-action-link btn-unlink"
                            disabled={selectedLinkedIds.size === 0 || linkChildrenSaving} onClick={unlinkSelectedChildren}>
                            <FontAwesomeIcon icon={faLinkSlash} aria-hidden="true" />
                            <span>{linkChildrenSaving ? t('users.linkChildren.saving') : t('users.linkChildren.unlinkSelected')}</span>
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Right: Available Students */}
                    <div className="col-md-6">
                      <div className="children-section">
                        <div className="section-header available">
                          <FontAwesomeIcon icon={faUserGraduate} aria-hidden="true" />
                          <span>{t('users.linkChildren.availableStudents')}</span>
                          <span className="badge-count">{numberFormatter.format(linkChildrenData.availableStudents.length)}</span>
                        </div>
                        <div className="search-box">
                          <input type="text" aria-label={t('users.linkChildren.searchAvailablePlaceholder')}
                            placeholder={t('users.linkChildren.searchAvailablePlaceholder')} value={availableSearch}
                            onChange={e => setAvailableSearch(e.target.value)} autoComplete="off" />
                        </div>
                        <div className="children-list">
                          {linkChildrenData.availableStudents
                            .filter(s => !availableSearch || s.fullName.toLowerCase().includes(availableSearch.toLowerCase()) || (s.email?.toLowerCase().includes(availableSearch.toLowerCase())))
                            .map(student => (
                              <label key={student.id} className={`child-item ${selectedAvailableIds.has(student.id) ? 'selected' : ''}`}>
                                <input type="checkbox" checked={selectedAvailableIds.has(student.id)}
                                  aria-label={t('users.a11y.availableStudent', { name: student.fullName })}
                                  disabled={linkChildrenSaving} onChange={() => toggleAvailableId(student.id)} />
                                <div className="child-info">
                                  <div className="child-name">{student.fullName}</div>
                                  <div className="child-email">{student.email}</div>
                                </div>
                                {student.groupName && <span className="child-group">{student.groupName}</span>}
                              </label>
                            ))}
                          {linkChildrenData.availableStudents.length === 0 && (
                            <div className="empty-state-children">
                              <FontAwesomeIcon icon={faUserGraduate} className="empty-state-children-icon" aria-hidden="true" />
                              <p>{t('users.linkChildren.noAvailableStudents')}</p>
                            </div>
                          )}
                        </div>
                        <div className="section-footer">
                          <button type="button" className="btn-action-link btn-link"
                            disabled={selectedAvailableIds.size === 0 || linkChildrenSaving} onClick={linkSelectedChildren}>
                            <FontAwesomeIcon icon={faLink} aria-hidden="true" />
                            <span>{linkChildrenSaving ? t('users.linkChildren.saving') : t('users.linkChildren.linkSelected')}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        </div>,
        document.body
      )}

      {isAdmin && bulkTeamsInviteOpen && (
        <TeacherTeamsBulkInviteModal
          accessScopeKey={accessScopeKey}
          campuses={campuses}
          campusesLoading={campusesLoading}
          campusesError={campusesError}
          initialCampusId={filterCampus}
          onClose={() => setBulkTeamsInviteOpen(false)}
        />
      )}

      {microsoftAccountUser && (
        <TeacherMicrosoftAccountModal
          teacher={microsoftAccountUser}
          access={isAdmin ? 'manage' : 'view'}
          accessScopeKey={accessScopeKey}
          onClose={() => setMicrosoftAccountUser(null)}
        />
      )}

      {/* ---- Re-link to a Tuwaiq account ---- */}
      {relinkUser && createPortal(
        <div className="user-form-modal-overlay" dir={i18n.dir()} onClick={closeRelinkModal}>
          <div ref={relinkDialogRef} className="user-form-modal-card user-relink-card"
            role="dialog" aria-modal="true" aria-labelledby="user-relink-title"
            aria-busy={relinkMutation.isPending}
            tabIndex={-1} onClick={e => e.stopPropagation()}>
            <div className="user-form-modal-header">
              <div>
                <h5 id="user-relink-title"><FontAwesomeIcon icon={faLink} aria-hidden="true" />{t('users.relink.title')}</h5>
                <p>{t('users.relink.subtitle', { name: relinkUser.fullName })}</p>
              </div>
              <button type="button" className="user-form-modal-close" aria-label={t('users.a11y.closeDialog')}
                disabled={relinkMutation.isPending} onClick={closeRelinkModal}>&times;</button>
            </div>

            <div className="user-relink-body">
              <div className="user-relink-current">
                <span className="user-relink-current-label">{t('users.relink.currentEmail')}</span>
                <span className="user-relink-current-value">{relinkUser.email}</span>
              </div>

              <label className="form-label required" htmlFor="user-relink-email">{t('users.relink.newEmail')}</label>
              <input
                id="user-relink-email"
                type="email"
                className="form-control"
                autoFocus
                autoComplete="off"
                placeholder={t('users.form.emailPlaceholder')}
                value={relinkEmail}
                disabled={relinkMutation.isPending}
                aria-describedby="user-relink-note"
                onChange={e => setRelinkEmail(e.target.value)}
              />

              {/* One line, and it is the whole point of this dialog: say what Confirm will do. */}
              <div id="user-relink-note" className="user-relink-note" role="status" aria-live="polite">
                {relinkNote === 'CHECKING' && (
                  <span className="checking">{t('users.relink.checking')}</span>
                )}
                {relinkNote === 'WILL_LINK' && (
                  <span className="link">
                    {relinkPreviewQuery.data?.matchedName
                      ? t('users.relink.willLinkNamed', { name: relinkPreviewQuery.data.matchedName })
                      : t('users.relink.willLink')}
                  </span>
                )}
                {relinkNote === 'WILL_CREATE' && <span className="new">{t('users.relink.willCreate')}</span>}
                {relinkNote === 'CANNOT_LINK' && <span className="warn">{t('users.relink.cannotLink')}</span>}
                {relinkNote === 'EMAIL_TAKEN' && <span className="warn">{t('users.relink.emailTaken')}</span>}
                {relinkNote === 'UNCHANGED' && <span className="warn">{t('users.relink.unchanged')}</span>}
                {relinkNote === 'UNAVAILABLE' && <span className="warn">{t('users.relink.unavailable')}</span>}
                {relinkNote === 'PROVISIONING_OFF' && <span className="warn">{t('users.relink.provisioningOff')}</span>}
              </div>

              <p className="user-relink-hint">{t('users.relink.hint')}</p>
            </div>

            <div className="user-form-modal-footer">
              <button type="button" className="btn-cancel"
                disabled={relinkMutation.isPending} onClick={closeRelinkModal}>
                {t('cancel')}
              </button>
              <button type="button" className="btn-save"
                disabled={!relinkCanSubmit} onClick={submitRelink}>
                {relinkMutation.isPending ? t('users.relink.saving') : t('users.relink.confirm')}
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

export default UsersListPage;
