// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { satteri } from '@astrojs/markdown-satteri';
import externalLinks from './src/lib/external-links.mjs';
import { sitemapLastmod } from './src/lib/sitemap-lastmod.mjs';

// Prod and dev differ ONLY here. Both build with base '/blog' so the
// dev site is a faithful rehearsal of production.
// See .claude/project-infrastructure/08-environments.md
const site = process.env.BLOG_SITE ?? 'https://cursedshrine.com';

export default defineConfig({
  site,
  base: '/blog',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [
    mdx(),
    sitemap({
      // Search is a thin client-side page with no content of its own.
      filter: (page) => new URL(page).pathname !== '/blog/search/',
      serialize: sitemapLastmod(),
    }),
  ],
  vite: { plugins: [tailwindcss()] },
  markdown: {
    shikiConfig: { theme: 'github-light', wrap: true },
    processor: satteri({ hastPlugins: [externalLinks({ site })] }),
  },
});
