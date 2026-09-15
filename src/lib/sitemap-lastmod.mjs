// <lastmod> for @astrojs/sitemap. Runs at config time, where astro:content
// isn't available, so it reads post frontmatter straight from disk.
// A post's lastmod is `updated` if set, else `date`. The blog home and each
// category page take the newest lastmod among the posts they list.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const POSTS_DIR = new URL('../content/posts/', import.meta.url).pathname;
const includeDrafts = process.env.BLOG_INCLUDE_DRAFTS === '1';

function field(frontmatter, name) {
  const m = frontmatter.match(new RegExp(`^${name}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : undefined;
}

function toDay(value) {
  const d = value ? new Date(value) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : undefined;
}

function readPosts() {
  const posts = [];
  for (const slug of readdirSync(POSTS_DIR)) {
    const file = ['index.md', 'index.mdx'].map((f) => join(POSTS_DIR, slug, f)).find(existsSync);
    if (!file) continue;
    const fm = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    // Same default as the content schema: no `draft:` means draft.
    const draft = field(fm, 'draft') !== 'false';
    if (draft && !includeDrafts) continue;
    const lastmod = toDay(field(fm, 'updated')) ?? toDay(field(fm, 'date'));
    if (lastmod) posts.push({ slug, category: field(fm, 'category'), lastmod });
  }
  return posts;
}

const newest = (list) => list.map((p) => p.lastmod).sort().at(-1);

export function sitemapLastmod() {
  const posts = readPosts();
  const byPath = new Map(posts.map((p) => [`/blog/posts/${p.slug}/`, p.lastmod]));
  byPath.set('/blog/', newest(posts));
  for (const cat of new Set(posts.map((p) => p.category))) {
    byPath.set(`/blog/category/${cat}/`, newest(posts.filter((p) => p.category === cat)));
  }
  return (item) => {
    const lastmod = byPath.get(new URL(item.url).pathname);
    if (lastmod) item.lastmod = lastmod;
    return item;
  };
}
