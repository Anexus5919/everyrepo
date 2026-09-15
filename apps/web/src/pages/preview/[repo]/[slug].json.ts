import type { APIRoute, GetStaticPaths } from "astro";
import { buildPreview, readablePages, repoKey } from "../../../lib/preview.ts";
import { loadRepos, loadWiki } from "../../../lib/site-data.ts";

// One file per written page, loaded when a reader opens that page in the home page preview
export const getStaticPaths: GetStaticPaths = () =>
  loadRepos()
    .filter((repo) => repo.status === "ready")
    .flatMap((repo) => {
      const wiki = loadWiki(repo.repo);
      return readablePages(wiki).map((page) => ({
        params: { repo: repoKey(repo.repo), slug: page.slug },
        props: { page },
      }));
    });

export const GET: APIRoute = async ({ props }) => {
  const preview = await buildPreview(props.page);
  return new Response(JSON.stringify(preview), {
    headers: { "Content-Type": "application/json" },
  });
};
