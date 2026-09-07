/**
 * Marginalia doodles.
 *
 * Plain path data, no icon dependency. Each entry is stroked with
 * currentColor so the ink follows the theme instead of being baked in.
 * Paths are drawn slightly off-true on purpose — a perfectly symmetric
 * circle reads as an icon, a wobbly one reads as a pen mark.
 */
export const sketches = [
  {
    name: 'quill',
    box: '0 0 64 64',
    d: [
      'M12 54c6-3 10-7 14-12',
      'M26 42c8-11 16-20 26-28-1 12-5 22-11 30-4 5-9 8-15 10',
      'M30 40c5-6 10-11 16-16',
      'M10 56l6-2',
    ],
  },
  {
    name: 'inkpot',
    box: '0 0 64 64',
    d: [
      'M20 30h24c1 0 2 1 2 2l-2 18c0 2-2 3-4 3H24c-2 0-4-1-4-3l-2-18c0-1 1-2 2-2z',
      'M24 30c0-4 3-7 8-7s8 3 8 7',
      'M28 22h8',
      'M46 24c3-2 6-1 7 2',
    ],
  },
  {
    name: 'moth',
    box: '0 0 64 64',
    d: [
      'M32 22v22',
      'M32 26c-6-8-16-10-20-4-3 5 2 13 10 17 4 2 8 3 10 3',
      'M32 26c6-8 16-10 20-4 3 5-2 13-10 17-4 2-8 3-10 3',
      'M32 22l-4-6M32 22l4-6',
    ],
  },
  {
    name: 'key',
    box: '0 0 64 64',
    d: [
      'M22 26a7 7 0 1 0 .1 0z',
      'M28 30l20 12',
      'M42 38l-3 5',
      'M47 41l-3 5',
    ],
  },
  {
    name: 'moon',
    box: '0 0 64 64',
    d: [
      'M40 14c-11 3-18 12-17 22 1 11 11 18 22 16-9-3-15-11-15-20 0-8 4-15 10-18z',
      'M48 22l2-4 2 4 4 2-4 2-2 4-2-4-4-2z',
    ],
  },
  {
    name: 'bird',
    box: '0 0 64 64',
    d: [
      'M12 34c6-6 12-8 18-6',
      'M30 28c4-6 10-8 16-6-3 1-5 3-6 5',
      'M30 28c-1 6 1 11 5 14',
      'M35 42c5 1 9-1 12-5',
      'M44 24l4-2',
    ],
  },
  {
    name: 'spiral',
    box: '0 0 64 64',
    d: [
      'M32 32c0-4 4-6 7-4 4 2 4 8 1 12-4 5-12 5-17 0-6-6-6-16 1-22 8-7 20-6 27 2',
    ],
  },
  {
    name: 'anchor',
    box: '0 0 64 64',
    d: [
      'M32 18a4 4 0 1 0 .1 0z',
      'M32 24v26',
      'M22 30h20',
      'M14 40c0 10 8 16 18 16s18-6 18-16',
      'M14 40l-4 4M50 40l4 4',
    ],
  },
  {
    name: 'lantern',
    box: '0 0 64 64',
    d: [
      'M26 24h12l3 22H23z',
      'M28 18c0-3 2-5 4-5s4 2 4 5',
      'M23 46h18',
      'M32 28v12',
      'M28 46l-2 6M36 46l2 6',
    ],
  },
  {
    name: 'compass',
    box: '0 0 64 64',
    d: [
      'M32 12a20 20 0 1 0 .1 0z',
      'M24 40l6-14 10-6-6 14z',
      'M32 12v4M32 48v4M12 32h4M48 32h4',
    ],
  },
  {
    name: 'leaf',
    box: '0 0 64 64',
    d: [
      'M18 46c0-16 10-28 28-30 2 16-8 30-24 32-2 0-4 0-4-2z',
      'M20 48c8-10 16-18 24-24',
      'M14 52l6-4',
    ],
  },
  {
    name: 'eye',
    box: '0 0 64 64',
    d: [
      'M10 32c8-10 16-14 22-14s14 4 22 14c-8 10-16 14-22 14s-14-4-22-14z',
      'M32 26a6 6 0 1 0 .1 0z',
      'M32 14v-4M18 20l-3-3M46 20l3-3',
    ],
  },
];
