# Brandloom

> learns an SMB's brand voice once, then pumps out on-brand social posts, captions and ad copy on a weekly schedule.

**Alternative to the product-shape pioneered by Kaya (YC S21)** — rank #2 of 500 in the [YC-500 Fable 5 Venture Blueprint](https://github.com/) (score 7.4/10).

## Why this exists
SMBs need marketing output but cannot afford real agencies. The buildable wedge: self-serve content and ad-copy generator with a brand memory.

## MVP scope
- [ ] Brand-voice setup
- [ ] weekly content plan
- [ ] post/caption drafts
- [ ] ad-copy variants
- [ ] approve-and-schedule

## Architecture
`Workers+Supabase+Claude` — Cloudflare Workers + Hono API, Supabase (Postgres + RLS + Auth + pgvector), Claude API via Agent SDK (claude-fable-5 for agent reasoning, claude-haiku-4-5 for volume), wrangler deploys.

**Integrations:** Claude API; Meta/Instagram Graph; Stripe
**Data:** Brand profile, past posts, product list, content calendar.
**Agent core:** Agent plans and drafts a full week of on-brand marketing content.

## Business
| | |
|---|---|
| Monetization | Flat monthly content subscription |
| First customer | Small D2C brand or local service business |
| GTM wedge | Show generated samples in founder/SMB communities; PLG free trial |
| Competition risk | High: countless AI content tools |
| Regulatory/trust risk | Low: marketing content only |
| India angle | Cheap on-brand content for India's exploding small-brand and creator economy. |
| Difficulty / build time | Low / 2-3 weeks |

## 30-day plan
- **W1:** core loop — Brand-voice setup + weekly content plan
- **W2:** post/caption drafts + ad-copy variants + approve-and-schedule + auth + billing
- **W3:** polish, instrument events, seed first users via: Show generated samples in founder/SMB communities; PLG free trial
- **W4:** launch + first revenue; kill/scale decision

---
*Built with Fable 5 (Claude Code). Blueprint row: inspired by Kaya — "AI-powered marketing agency delivering campaigns cheaper and faster."*