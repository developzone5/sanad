import { useTranslation } from 'react-i18next';
import { formatDate } from '@/utils/dates';

export interface HomeworkCardProps {
  title: string;
  dueAt: string | null;
}

export function HomeworkCard({ title, dueAt }: HomeworkCardProps) {
  const { i18n } = useTranslation();
  return (
    <article className="hw-card">
      <h3 dir="auto">{title}</h3>
      {dueAt && (
        <p className="hw-card-due">
          Due: {formatDate(dueAt, i18n.language)}
        </p>
      )}
    </article>
  );
}
