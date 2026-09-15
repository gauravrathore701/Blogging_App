// Sätteri hast plugin: open links to other sites in a new tab. Links to
// our own host, and relative links like /blog/..., stay in the same tab.
export default function externalLinks({ site }) {
  const ownHost = new URL(site).hostname;

  return {
    name: 'external-links',
    element: {
      filter: ['a'],
      visit(node, ctx) {
        const href = String(node.properties?.href ?? '');
        if (!/^https?:\/\//i.test(href)) return;
        if (new URL(href).hostname === ownHost) return;
        ctx.setProperty(node, 'target', '_blank');
        ctx.setProperty(node, 'rel', 'noopener noreferrer');
      },
    },
  };
}
