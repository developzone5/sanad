import { api } from './client';

export interface CourseDto {
  id: number;
  title: string;
  seatsLeft: number;
}

export const coursesApi = {
  get: (id: number) => api.get<CourseDto>(`/courses/${id}`).then((r) => r.data),
};
