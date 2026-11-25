// ===================================================
// SettingsPage - Self-service account settings (ALL roles)
// Backend: AccountController.cs → /api/v1/account/*
//
// Every authenticated role manages their OWN account here — the server
// resolves the target row from the JWT claims, so nothing on this page
// carries a user id. FullName/Email render read-only (admin-managed).
// Strings via t('settings.*') — the block ships in the router/i18n handoff.
// ===================================================

import { useCallback, useEffect, useMemo, useRef, type ChangeEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm, useWatch, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useTranslation } from 'react-i18next';
import { useBlocker } from 'react-router-dom';
import Flatpickr from 'react-flatpickr';
import 'flatpickr/dist/flatpickr.min.css';
import {
  Settings, User, Globe, Lock,
  Calendar, Clock, Edit3, AlertTriangle, RefreshCw, Camera,
} from 'react-feather';
import Swal from 'sweetalert2';
import { accountApi } from '@/api/account';
import useUIStore from '@/stores/ui-store';
import useAuthStore from '@/stores/auth-store';
import type { AccountProfileDto } from '@/types/account';
import { getAccessScopeKey } from '@/utils/access-scope-key';
import { getApiErrorMessage } from '@/utils/api-error';
import { hasAnyRole } from '@/utils/role-helpers';
import useUnsavedChangesGuard from '@/hooks/use-unsaved-changes-guard';

import '@/styles/users-management.css';
import '@/styles/settings.css';

const MS_PER_DAY = 86_400_000;
const BRAND_PURPLE = '#4f29b7';

// ---- Zod schemas (messages via t so they are translated) ----
function buildProfileSchema(t: (k: string) => string) {
  return z.object({
    phone: z.string()
      .max(50, t('settings.valPhoneMax'))
      .refine(v => !v || /^\+?[0-9\s-]{7,49}$/.test(v), t('settings.valPhoneInvalid'))
      .optional().or(z.literal('')),
    dateOfBirth: z.string().optional().or(z.literal('')),
    gender: z.string()
      .refine(v => ['', 'Male', 'Female'].includes(v), t('settings.valGenderInvalid')),
    preferredLanguage: z.string()
      .refine(v => ['en', 'ar'].includes(v), t('settings.valLanguageInvalid')),
    timeZone: z.string()
      .refine(v => ['Asia/Riyadh', 'UTC'].includes(v), t('settings.valTimeZoneInvalid')),
    emailTicketAlerts: z.boolean(),
  });
}
type ProfileFormData = z.infer<ReturnType<typeof buildProfileSchema>>;

// Legacy rows may store the Windows zone id ("Arab Standard Time" = Riyadh, UTC+3);
// the select maps it onto its IANA equivalent so saving normalizes the account.
function toAllowedTimeZone(timeZone: string): 'Asia/Riyadh' | 'UTC' {
  return timeZone === 'UTC' ? 'UTC' : 'Asia/Riyadh';
}

function toFormValues(profile: AccountProfileDto): ProfileFormData {
  const language = profile.preferredLanguage?.toLowerCase() === 'en' ? 'en' : 'ar';
  return {
    phone: profile.phone || '',
    dateOfBirth: profile.dateOfBirth ? profile.dateOfBirth.split('T')[0] : '',
    gender: profile.gender === 'Male' || profile.gender === 'Female' ? profile.gender : '',
    preferredLanguage: language,
    timeZone: toAllowedTimeZone(profile.timeZone),
    emailTicketAlerts: profile.emailTicketAlerts ?? true,
  };
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / MS_PER_DAY));
}

function SettingsPage() {
  const { t, i18n } = useTranslation();
  const isAr = i18n.language === 'ar';
  const numberFormatter = useMemo(
    () => new Intl.NumberFormat(isAr ? 'ar-SA' : 'en-US'),
    [isAr],
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(isAr ? 'ar-SA-u-ca-gregory' : 'en-US', {
      year: 'numeric', month: 'short', day: '2-digit',
    }),
    [isAr],
  );
  const queryClient = useQueryClient();

  const uiLanguage = useUIStore(s => s.language);
  const setLanguage = useUIStore(s => s.setLanguage);
  const user = useAuthStore(s => s.user);
  const setProfilePicture = useAuthStore(s => s.setProfilePicture);
  const roles = user?.roles ?? [];
  const accessScopeKey = getAccessScopeKey(user);
  // Only staff can be the target of a new-ticket alert (routed assignee or admins). Keep in step
  // with the staff routing in TicketService.CreateAsync by hand.
  const receivesTicketAlerts = hasAnyRole(roles, ['Admin', 'Manager', 'Teacher']);

  const profileSchema = useMemo(() => buildProfileSchema(t), [t]);

  // ---- Own profile (single source for the hero stats + the form) ----
  const { data: profile, isLoading, isError, refetch } = useQuery({
    queryKey: ['account-profile', accessScopeKey],
    queryFn: ({ signal }) => accountApi.getProfile(signal),
    staleTime: 5 * 60 * 1000,
  });

  // ===================================================
  // PROFILE FORM
  // ===================================================
  const {
    register: registerProfile,
    handleSubmit: handleProfileSubmit,
    formState: { errors: profileErrors, isDirty: profileDirty, isValid: profileValid },
    reset: resetProfile,
    control: profileControl,
  } = useForm<ProfileFormData>({
    resolver: zodResolver(profileSchema),
    mode: 'onChange',
    defaultValues: { phone: '', dateOfBirth: '', gender: '', preferredLanguage: 'ar', timeZone: 'Asia/Riyadh', emailTicketAlerts: true },
  });

  // Populate once the profile arrives; never clobber in-progress edits on a refetch.
  useEffect(() => {
    if (profile && !profileDirty) resetProfile(toFormValues(profile));
  }, [profile, profileDirty, resetProfile]);

  const watchedPhone = useWatch({ control: profileControl, name: 'phone' });
  const watchedDob = useWatch({ control: profileControl, name: 'dateOfBirth' });
  const watchedGender = useWatch({ control: profileControl, name: 'gender' });

  const profileMutation = useMutation({
    mutationFn: accountApi.updateProfile,
    onSuccess: (saved) => {
      queryClient.setQueryData(['account-profile', accessScopeKey], saved);
      resetProfile(toFormValues(saved)); // pristine again → save disabled, nav guard released
      // Keep the UI language in sync with the saved account default.
      const savedLanguage = saved.preferredLanguage?.toLowerCase() === 'en' ? 'en' : 'ar';
      if (savedLanguage !== uiLanguage) setLanguage(savedLanguage);
      void Swal.fire({
        icon: 'success', title: t('settings.swalSuccess'),
        text: t('settings.updateSuccess'), confirmButtonColor: BRAND_PURPLE,
      });
    },
    onError: (error) => {
      const serverMessage = getApiErrorMessage(error);
      void Swal.fire({
        icon: 'error', title: t('settings.swalError'),
        text: !isAr && serverMessage?.trim() ? serverMessage : t('settings.updateError'),
        confirmButtonColor: BRAND_PURPLE,
      });
    },
  });

  function onProfileSubmit(formData: ProfileFormData) {
    profileMutation.mutate({
      phone: formData.phone?.trim() || null,
      dateOfBirth: formData.dateOfBirth || null,
      gender: formData.gender || null,
      preferredLanguage: formData.preferredLanguage,
      timeZone: formData.timeZone,
      emailTicketAlerts: formData.emailTicketAlerts,
    });
  }

  // ===================================================
  // PROFILE PICTURE
  // ===================================================
  const fileInputRef = useRef<HTMLInputElement>(null);

  const pictureMutation = useMutation({
    mutationFn: (file: File) => accountApi.uploadProfilePicture(file),
    onSuccess: (saved) => {
      queryClient.setQueryData(['account-profile', accessScopeKey], saved);
      setProfilePicture(saved.profilePictureUrl ?? null); // reflect in the topbar / app-wide avatar
      void Swal.fire({
        icon: 'success', title: t('settings.swalSuccess'),
        text: t('settings.photoUpdated'), confirmButtonColor: BRAND_PURPLE,
      });
    },
    onError: (error) => {
      const serverMessage = getApiErrorMessage(error);
      void Swal.fire({
        icon: 'error', title: t('settings.swalError'),
        text: !isAr && serverMessage?.trim() ? serverMessage : t('settings.photoError'),
        confirmButtonColor: BRAND_PURPLE,
      });
    },
    onSettled: () => { if (fileInputRef.current) fileInputRef.current.value = ''; },
  });

  const removePictureMutation = useMutation({
    mutationFn: () => accountApi.deleteProfilePicture(),
    onSuccess: (saved) => {
      queryClient.setQueryData(['account-profile', accessScopeKey], saved);
      setProfilePicture(saved.profilePictureUrl ?? null); // clear it from the topbar / app-wide avatar
      void Swal.fire({
        icon: 'success', title: t('settings.swalSuccess'),
        text: t('settings.photoRemoved'), confirmButtonColor: BRAND_PURPLE,
      });
    },
    onError: (error) => {
      const serverMessage = getApiErrorMessage(error);
      void Swal.fire({
        icon: 'error', title: t('settings.swalError'),
        text: !isAr && serverMessage?.trim() ? serverMessage : t('settings.photoError'),
        confirmButtonColor: BRAND_PURPLE,
      });
    },
  });

  const pictureBusy = pictureMutation.isPending || removePictureMutation.isPending;

  function onPickProfilePicture(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type)) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      void Swal.fire({ icon: 'error', title: t('settings.swalError'), text: t('settings.photoInvalidType'), confirmButtonColor: BRAND_PURPLE });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      void Swal.fire({ icon: 'error', title: t('settings.swalError'), text: t('settings.photoTooLarge'), confirmButtonColor: BRAND_PURPLE });
      return;
    }
    pictureMutation.mutate(file);
  }

  // ===================================================
  // UNSAVED-CHANGES GUARD (in-app navigation + hard unload)
  // ===================================================
  const hasUnsavedChanges = profileDirty && !profileMutation.isPending;

  // Set once the user has answered "leave" in our own dialog. The beforeunload handler below
  // reads it so the browser's native "Leave site?" prompt cannot ask the same question a second
  // time — under SSO the Keycloak redirect can outrun React's unmount, which is what would
  // otherwise leave the listener attached past the answer.
  const leaveConfirmedRef = useRef(false);

  // One prompt, shared by every way out of this page, so the wording never differs.
  const confirmDiscard = useCallback(async () => {
    const result = await Swal.fire({
      icon: 'warning',
      title: t('settings.unsavedTitle'),
      text: t('settings.unsavedText'),
      showCancelButton: true,
      confirmButtonColor: '#dc3545',
      confirmButtonText: t('settings.unsavedLeave'),
      cancelButtonText: t('settings.unsavedStay'),
    });
    if (result.isConfirmed) leaveConfirmedRef.current = true;
    return result.isConfirmed;
  }, [t]);

  // Exit 1 — in-app navigation (sidebar link, back button, a card that routes away).
  const blocker = useBlocker(hasUnsavedChanges);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void confirmDiscard().then(leave => {
      if (leave) blocker.proceed();
      else blocker.reset();
    });
  }, [blocker, confirmDiscard]);

  // Exit 2 — Sign Out, which the blocker above cannot see. It clears the auth store
  // first, so ProtectedRoute unmounts this page (blocker and all) before anything
  // navigates. The topbar asks this registered prompt before it starts tearing down.
  //
  // Armed on profileDirty alone, NOT hasUnsavedChanges: an in-flight save is the one moment
  // the edits exist only on the wire. Signing out there tears the page down and, under SSO,
  // redirects to Keycloak — which cancels the request and loses the save with nothing said.
  useUnsavedChangesGuard(profileDirty, confirmDiscard);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    // Freshly dirty again — whatever was answered about the last set of edits does not carry.
    leaveConfirmedRef.current = false;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (leaveConfirmedRef.current) return;  // already answered in our own dialog
      event.preventDefault();
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [hasUnsavedChanges]);

  // ===================================================
  // HERO STATS (derived client-side; completion is LIVE from the form)
  // ===================================================
  const accountAgeDays = daysSince(profile?.createdAt ?? null);
  const lastLoginDays = daysSince(profile?.lastLoginAt ?? null);
  const lastUpdateDays = daysSince(profile?.updatedAt ?? null);

  // fullName/phone/dateOfBirth/gender/profilePictureUrl — 20% each. Phone/DOB/gender read
  // the WATCHED values so the ring moves as the user types, before saving.
  const completion = useMemo(() => {
    if (!profile) return 0;
    let score = 0;
    if (profile.fullName?.trim()) score += 20;
    if ((watchedPhone || '').trim()) score += 20;
    if ((watchedDob || '').trim()) score += 20;
    if (watchedGender) score += 20;
    if (profile.profilePictureUrl?.trim()) score += 20;
    return score;
  }, [profile, watchedPhone, watchedDob, watchedGender]);

  const RING_RADIUS = 26;
  const ringCircumference = 2 * Math.PI * RING_RADIUS;

  function fmtDate(value: string | null): string {
    if (!value) return t('settings.never');
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? t('settings.never') : dateFormatter.format(date);
  }

  function fmtDays(days: number | null): string {
    return days === null ? '—' : numberFormatter.format(days);
  }

  const isSavingProfile = profileMutation.isPending;
  const avatarInitial = profile?.fullName?.trim().charAt(0).toUpperCase() || '?';

  // ===================================================
  // LOAD / ERROR STATES
  // ===================================================
  if (isLoading && !profile) {
    return (
      <div className="settings-page" aria-busy="true">
        <div className="table-loading" role="status" aria-label={t('settings.loading')}>
          <div className="loader-dots"><span></span><span></span><span></span></div>
        </div>
      </div>
    );
  }

  if (isError && !profile) {
    return (
      <section className="settings-page settings-load-error" role="alert">
        <AlertTriangle aria-hidden="true" />
        <h1>{t('settings.loadErrorTitle')}</h1>
        <p>{t('settings.loadErrorText')}</p>
        <button type="button" className="btn btn-primary settings-retry-btn" onClick={() => void refetch()}>
          <RefreshCw aria-hidden="true" /> {t('settings.retry')}
        </button>
      </section>
    );
  }

  if (!profile) return null;

  return (
    <div className="settings-page">
      {/* ======== HERO ======== */}
      <div className="users-hero settings-hero">
        <div className="hero-content">
          <div className="hero-header">
            <div>
              <h1 className="hero-title">
                <Settings aria-hidden="true" />
                {t('settings.heroTitle')}
              </h1>
              <p className="hero-subtitle">{t('settings.heroSubtitle')}</p>
            </div>
          </div>

          <div className="stats-container settings-stats">
            <div className="stat-card stat-primary">
              <div className="stat-icon"><Calendar aria-hidden="true" /></div>
              <span className="stat-number">{fmtDays(accountAgeDays)}</span>
              <div className="stat-label">{t('settings.statAccountAge')}</div>
              <div className="stat-subtext">{fmtDate(profile.createdAt)}</div>
            </div>
            <div className="stat-card stat-info">
              <div className="stat-icon"><Clock aria-hidden="true" /></div>
              <span className="stat-number">{fmtDays(lastLoginDays)}</span>
              <div className="stat-label">{t('settings.statLastLogin')}</div>
              <div className="stat-subtext">{fmtDate(profile.lastLoginAt)}</div>
            </div>
            <div className="stat-card stat-warning">
              <div className="stat-icon"><Edit3 aria-hidden="true" /></div>
              <span className="stat-number">{fmtDays(lastUpdateDays)}</span>
              <div className="stat-label">{t('settings.statLastUpdate')}</div>
              <div className="stat-subtext">{fmtDate(profile.updatedAt)}</div>
            </div>
            <div className="stat-card stat-success settings-completion-card">
              <div
                className="settings-ring-wrap"
                role="img"
                aria-label={t('settings.a11yCompletion', { percent: numberFormatter.format(completion) })}
              >
                <svg className="settings-ring" viewBox="0 0 64 64" aria-hidden="true">
                  <circle className="settings-ring-track" cx="32" cy="32" r={RING_RADIUS} />
                  <circle
                    className="settings-ring-fill"
                    cx="32" cy="32" r={RING_RADIUS}
                    strokeDasharray={ringCircumference}
                    strokeDashoffset={ringCircumference * (1 - completion / 100)}
                  />
                </svg>
                <span className="settings-ring-value">{numberFormatter.format(completion)}%</span>
              </div>
              <div className="stat-label">{t('settings.statCompletion')}</div>
              <div className="stat-subtext">{t('settings.statCompletionHint')}</div>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-grid">
        {/* ---- Profile Information ---- */}
        <section className="settings-card" aria-labelledby="settings-profile-title">
          <div className="settings-card-header">
            <h2 id="settings-profile-title" className="settings-card-title">
              <User aria-hidden="true" /> {t('settings.profileTitle')}
            </h2>
            <p className="settings-card-subtitle">{t('settings.profileSubtitle')}</p>
          </div>

          <div className="settings-identity">
            <div className="settings-avatar-wrap">
              {profile.profilePictureUrl
                ? <img src={profile.profilePictureUrl} alt="" className="settings-avatar settings-avatar-img" />
                : <div className="settings-avatar" aria-hidden="true">{avatarInitial}</div>}
              <button
                type="button"
                className="settings-avatar-edit"
                onClick={() => fileInputRef.current?.click()}
                disabled={pictureBusy}
                aria-label={t('settings.changePhoto')}
                title={t('settings.changePhoto')}
              >
                <Camera aria-hidden="true" />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg"
                className="settings-avatar-input"
                onChange={onPickProfilePicture}
              />
            </div>
            <div className="settings-identity-info">
              <div className="settings-identity-name" dir="auto">{profile.fullName}</div>
              <div className="settings-identity-email" dir="ltr">{profile.email}</div>
              {roles.length > 0 && (
                <div className="settings-identity-roles">
                  {roles.map(role => (
                    <span key={role} className="settings-role-badge">{role}</span>
                  ))}
                </div>
              )}
              <div className="settings-avatar-actions">
                <button type="button" className="settings-avatar-action" onClick={() => fileInputRef.current?.click()} disabled={pictureBusy}>
                  {t('settings.changePhoto')}
                </button>
                {profile.profilePictureUrl && (
                  <button type="button" className="settings-avatar-action settings-avatar-remove" onClick={() => removePictureMutation.mutate()} disabled={pictureBusy}>
                    {t('settings.removePhoto')}
                  </button>
                )}
              </div>
            </div>
          </div>

          <form onSubmit={handleProfileSubmit(onProfileSubmit)} noValidate>
            <div className="form-section">
              <div className="row">
                {/* Read-only pair — locked with the WHY, not just disabled */}
                <div className="col-md-6 mb-3">
                  <label className="form-label" htmlFor="settings-fullname">{t('settings.fullName')}</label>
                  <div className="settings-locked-field">
                    <input
                      id="settings-fullname"
                      type="text"
                      className="form-control"
                      value={profile.fullName}
                      readOnly
                      dir="auto"
                      aria-describedby="settings-fullname-hint"
                    />
                    <Lock className="settings-locked-icon" aria-hidden="true" />
                  </div>
                  <div id="settings-fullname-hint" className="settings-locked-hint">
                    {t('settings.lockedFieldHint')}
                  </div>
                </div>
                <div className="col-md-6 mb-3">
                  <label className="form-label" htmlFor="settings-email">{t('settings.email')}</label>
                  <div className="settings-locked-field">
                    <input
                      id="settings-email"
                      type="email"
                      className="form-control"
                      value={profile.email}
                      readOnly
                      dir="ltr"
                      aria-describedby="settings-email-hint"
                    />
                    <Lock className="settings-locked-icon" aria-hidden="true" />
                  </div>
                  <div id="settings-email-hint" className="settings-locked-hint">
                    {t('settings.lockedFieldHint')}
                  </div>
                </div>
              </div>

              <div className="row">
                <div className="col-md-6 mb-3">
                  <label className="form-label" htmlFor="settings-phone">{t('settings.phone')}</label>
                  <input
                    id="settings-phone"
                    type="tel"
                    inputMode="tel"
                    dir="ltr"
                    className={`form-control ${profileErrors.phone ? 'is-invalid' : ''}`}
                    placeholder={t('settings.phonePlaceholder')}
                    maxLength={50}
                    autoComplete="tel"
                    aria-invalid={Boolean(profileErrors.phone)}
                    aria-describedby={profileErrors.phone ? 'settings-phone-error' : undefined}
                    {...registerProfile('phone')}
                  />
                  {profileErrors.phone && (
                    <div id="settings-phone-error" className="invalid-feedback" role="alert">
                      {profileErrors.phone.message}
                    </div>
                  )}
                </div>
                <div className="col-md-6 mb-3">
                  <label className="form-label" htmlFor="settings-dob">{t('settings.dateOfBirth')}</label>
                  <Controller
                    name="dateOfBirth"
                    control={profileControl}
                    render={({ field }) => (
                      <Flatpickr
                        id="settings-dob"
                        className="form-control"
                        placeholder={t('settings.dateOfBirthPlaceholder')}
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
              </div>

              <div className="row">
                <div className="col-md-6 mb-3">
                  <label className="form-label" htmlFor="settings-gender">{t('settings.gender')}</label>
                  <select
                    id="settings-gender"
                    className={`form-control ${profileErrors.gender ? 'is-invalid' : ''}`}
                    aria-invalid={Boolean(profileErrors.gender)}
                    {...registerProfile('gender')}
                  >
                    <option value="">{t('settings.genderNotSet')}</option>
                    <option value="Male">{t('settings.genderMale')}</option>
                    <option value="Female">{t('settings.genderFemale')}</option>
                  </select>
                </div>
                <div className="col-md-6 mb-3">
                  <label className="form-label" htmlFor="settings-language">
                    <Globe className="settings-label-icon" aria-hidden="true" /> {t('settings.preferredLanguage')}
                  </label>
                  <select
                    id="settings-language"
                    className="form-control"
                    aria-describedby="settings-language-hint"
                    {...registerProfile('preferredLanguage')}
                  >
                    <option value="en">{t('settings.langEnglish')}</option>
                    <option value="ar">{t('settings.langArabic')}</option>
                  </select>
                  <div id="settings-language-hint" className="form-hint settings-field-hint">
                    {t('settings.languageSyncHint')}
                  </div>
                </div>
              </div>

              <div className="row">
                <div className="col-md-6 mb-3">
                  <label className="form-label" htmlFor="settings-timezone">{t('settings.timeZone')}</label>
                  <select
                    id="settings-timezone"
                    className="form-control"
                    {...registerProfile('timeZone')}
                  >
                    <option value="Asia/Riyadh">{t('settings.tzRiyadh')}</option>
                    <option value="UTC">{t('settings.tzUtc')}</option>
                  </select>
                </div>
                {receivesTicketAlerts && (
                  <div className="col-md-6 mb-3">
                    <div className="settings-switch-row">
                      <input
                        id="settings-email-ticket-alerts"
                        type="checkbox"
                        role="switch"
                        className="settings-switch"
                        aria-describedby="settings-email-ticket-alerts-hint"
                        {...registerProfile('emailTicketAlerts')}
                      />
                      <label className="settings-switch-label" htmlFor="settings-email-ticket-alerts">
                        {t('settings.emailTicketAlerts')}
                      </label>
                    </div>
                    <div id="settings-email-ticket-alerts-hint" className="form-hint settings-field-hint">
                      {t('settings.emailTicketAlertsHint')}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="settings-card-footer">
              {profileDirty && (
                <button
                  type="button"
                  className="btn-cancel"
                  disabled={isSavingProfile}
                  onClick={() => resetProfile(toFormValues(profile))}
                >
                  {t('settings.btnDiscard')}
                </button>
              )}
              <button
                type="submit"
                className="btn btn-primary btn-save"
                disabled={!profileDirty || !profileValid || isSavingProfile}
              >
                {isSavingProfile ? t('settings.btnSaving') : t('settings.btnSaveProfile')}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

export default SettingsPage;
