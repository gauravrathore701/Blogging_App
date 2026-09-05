import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Category is a field, never part of the URL. Adding a category later
// must never break an existing post URL.
// See .claude/project-infrastructure/07-niche-and-hostname.md
const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string().max(120),
    description: z.string().max(200),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    category: z.enum(['tech', 'finance', 'current-affairs', 'books']),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(true),
  }),
});

export const collections = { posts };
