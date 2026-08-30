import { useQuery, UseQueryResult } from "@tanstack/react-query";
import {
  getPublicContent,
  IPublicPageList,
} from "@/features/public/services/public-service";

export function usePublicContentQuery(): UseQueryResult<
  IPublicPageList,
  Error
> {
  return useQuery({
    queryKey: ["public-content"],
    queryFn: () => getPublicContent({ limit: 12 }),
    // Discovery is an enhancement, not core: never retry, and let an error surface so the section can
    // hide itself while the rest of the landing page still renders.
    retry: false,
  });
}
