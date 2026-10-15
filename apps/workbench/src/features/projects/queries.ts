import { useQuery } from '@tanstack/react-query';
import { getProjects } from '../../shared/api/reviews';

export function useProjects() {
  return useQuery({ queryKey: ['projects'], queryFn: ({ signal }) => getProjects(signal), staleTime: 30_000, retry: false });
}

export function projectReviewsPath(projectId: string) {
  return `/projects/${encodeURIComponent(projectId)}/reviews`;
}
