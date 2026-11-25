import { api } from './client';

export interface AnnouncementDto {
  id: number;
  title: string;
  publishedAt: string;
}

export const announcementsApi = {
  latest: () => api.get<AnnouncementDto[]>('/announcements/latest').then((r) => r.data),
};
