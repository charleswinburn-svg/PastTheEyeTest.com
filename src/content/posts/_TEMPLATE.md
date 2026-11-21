---
title: Your title here
date: 2026-01-31
type: article
summary: One sentence that shows on the Home page card.
tags: [mlb]
cover: /posts/your-slug/cover.png
preview: /posts/your-slug/thumb.png
share: /posts/your-slug/share.jpg
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
- `share` is optional: the picture in the X card when the link is posted. Best at 1200×630; make one
  from any photo (kept whole, on a blurred copy of itself) with
  `python3 scripts/make_share_image.py public/posts/your-slug/photo.jpg public/posts/your-slug/share.jpg`.
  Without it, X uses the preview (or cover, or first image) and crops it to fit.
- Posting to X: open the post and press **Post on X** (or copy the link). Keep the link at the end of
  your X post; X shows the share picture and title as a card and hides the link text. The card only
  works once the post is live on the site.
- Two images side by side under one caption:
  `<figure><div class="fig-pair"><img src="…" alt="…" /><img src="…" alt="…" /></div><figcaption>Caption</figcaption></figure>`
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
