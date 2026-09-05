import type { APIRoute } from 'astro';
import { getPosts } from '../lib/posts';

// Pagefind was the original choice but its Rust binary aborts on this Pi
// (16 KB kernel page size, jemalloc "Unsupported system page size").
// This endpoint emits a plain JSON index instead; MiniSearch queries it
// client-side. Still fully static, no server, no native binary.
// See .claude/project-infrastructure/10-search-decision.md
export const GET: APIRoute = async () => {
  const posts = await getPosts();
  const index = posts.map((post) => ({
    id: post.id,
    title: post.data.title,
    description: post.data.description,
    category: post.data.category,
    tags: post.data.tags.join(' '),
    date: post.data.date.toISOString().slice(0, 10),
    body: post.body?.replace(/[#*`>\[\]()_-]/g, ' ').replace(/\s+/g, ' ').trim() ?? '',
  }));
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json' },
  });
};
