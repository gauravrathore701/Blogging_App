// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Prod and dev differ ONLY here. Both build with base '/blog' so the
// dev site is a faithful rehearsal of production.
// See .claude/project-infrastructure/08-environments.md
const site = process.env.BLOG_SITE ?? 'https://cursedshrine.com';

export default defineConfig({
  site,
  base: '/blog',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [mdx(), sitemap()],
  vite: { plugins: [tailwindcss()] },
  markdown: {
    shikiConfig: { theme: 'github-dark', wrap: true },
  },
});
