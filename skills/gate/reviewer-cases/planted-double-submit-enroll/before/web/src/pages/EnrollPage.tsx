import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { coursesApi } from '@/api/courses';

export default function EnrollPage({ courseId }: { courseId: number }) {
  const { t } = useTranslation();
  const { data: course } = useQuery({ queryKey: ['course', courseId], queryFn: () => coursesApi.get(courseId) });

  if (!course) return null;
  return (
    <section>
      <h1>{course.title}</h1>
      <p>{t('courses.seatsLeft', { count: course.seatsLeft })}</p>
    </section>
  );
}
