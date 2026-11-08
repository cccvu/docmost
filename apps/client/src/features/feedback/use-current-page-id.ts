import { useMatch } from "react-router-dom";
import { usePageQuery } from "@/features/page/queries/page-query";
import { extractPageSlugId } from "@/lib";

/**
 * The id (uuid) of the page the reporter is looking at, or undefined off a page. Resolved from the route's
 * page slug through the existing page query (the page view already holds it in the cache, so this adds no
 * request on a page). Only the id is used: the slug and title stay in the browser.
 */
export function useCurrentPageId(active: boolean): string | undefined {
  const match = useMatch("/s/:spaceSlug/p/:pageSlug");
  const slugId = active
    ? extractPageSlugId(match?.params.pageSlug ?? "")
    : undefined;
  const { data } = usePageQuery({ pageId: slugId });
  return slugId ? data?.id : undefined;
}
