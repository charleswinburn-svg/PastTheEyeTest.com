---
title: Your title here
date: 2026-01-31
type: article
summary: One sentence that shows on the Home page card.
tags: [mlb]
cover: /posts/your-slug/cover.png
preview: /posts/your-slug/thumb.png
pinned: false
draft: true
---

Copy this file to `src/content/posts/YYYY-MM-DD-your-slug.md`. The part after the date
becomes the URL: `/posts/your-slug`. Files starting with `_` (like this one) are ignored.

- `type: update` posts show in full in the Home page's Updates feed. Keep them short.
- `type: article` posts show as cards that open their own page.
- `draft: true` keeps a post off the site. Delete the line to publish.
- `cover` is optional. Put images in `public/posts/your-slug/` and link them as `/posts/your-slug/name.png`.
- `preview` is optional: the thumbnail on the Home page preview card. Without it, Home uses the cover,
  else the post's first image. Home shows each post as a preview (title, thumbnail, opening lines);
  clicking it opens the full post.
- Images with a caption underneath:
  `<figure><img src="/posts/your-slug/chart.png" alt="…" /><figcaption>Caption</figcaption></figure>`

## Writing

Regular Markdown works: **bold**, *italics*, [links](https://example.com), lists,
> quotes,

tables,

| Pitch | Stuff+ |
|---|---|
| Sweeper | 124 |

and images: `![alt text](/posts/your-slug/chart.png)`
