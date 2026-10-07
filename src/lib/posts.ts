import { getCollection, type CollectionEntry } from 'astro:content';

/** Dev builds show drafts, prod builds must not. The prod build never
 *  renders a draft, so it cannot leak via sitemap, RSS or a guessed URL.
 *  See .claude/project-infrastructure/08-environments.md */
export const includeDrafts = process.env.BLOG_INCLUDE_DRAFTS === '1';

/** Dev is a review queue, not a second copy of the live site: by default it
 *  renders ONLY drafts, so what is on dev is exactly what still needs a look.
 *  Build with BLOG_DRAFTS_ONLY=0 (`npm run build:dev:all`) when reviewing
 *  edits to a post that is already live. Never set in a prod build. */
export const draftsOnly = includeDrafts && process.env.BLOG_DRAFTS_ONLY !== '0';

export function isVisible(data: { draft: boolean }): boolean {
  if (!includeDrafts) return data.draft === false;
  return draftsOnly ? data.draft === true : true;
}

export async function getPosts(): Promise<CollectionEntry<'posts'>[]> {
  const posts = await getCollection('posts', ({ data }) => isVisible(data));
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export const CATEGORIES = {
  tech: 'Tech',
  finance: 'Finance',
  'current-affairs': 'Current Affairs',
  books: 'Books',
} as const;
