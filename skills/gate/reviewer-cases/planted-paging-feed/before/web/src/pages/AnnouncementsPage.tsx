import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { announcementsApi } from '@/api/announcements';

export default function AnnouncementsPage() {
  const { t } = useTranslation();
  const { data = [], isLoading } = useQuery({
    queryKey: ['announcements', 'latest'],
    queryFn: () => announcementsApi.latest(),
  });

  if (isLoading) return <p>{t('loading')}</p>;
  return (
    <ul className="announcements">
      {data.map((a) => (
        <li key={a.id}>{a.title}</li>
      ))}
    </ul>
  );
}
