import rss from '@astrojs/rss';
import { getPosts } from '../lib/posts';

export async function GET(context) {
  const posts = await getPosts();
  return rss({
    title: 'Cursed Shrine',
    description: 'Tech, homelab teardowns, finance and books.',
    site: context.site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.date,
      categories: [post.data.category, ...post.data.tags],
      link: `/blog/posts/${post.id}`,
    })),
  });
}
