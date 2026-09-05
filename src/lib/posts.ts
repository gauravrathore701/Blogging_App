import { getCollection, type CollectionEntry } from 'astro:content';

/** Dev builds show drafts, prod builds must not. The prod build never
 *  renders a draft, so it cannot leak via sitemap, RSS or a guessed URL.
 *  See .claude/project-infrastructure/08-environments.md */
export const includeDrafts = process.env.BLOG_INCLUDE_DRAFTS === '1';

export async function getPosts(): Promise<CollectionEntry<'posts'>[]> {
  const posts = await getCollection('posts', ({ data }) =>
    includeDrafts ? true : data.draft === false,
  );
  return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
}

export const CATEGORIES = {
  tech: 'Tech',
  finance: 'Finance',
  'current-affairs': 'Current Affairs',
  books: 'Books',
} as const;
