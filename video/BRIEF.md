---
workflow: general-video
flow: automation
storyboard: no
message: "Engram gives agents a memory that ages, consolidates, and answers for itself"
destination: youtube-devpost
aspect: 1920x1080
language: en
length: 170s
angle: live-demo-plus-graphics
voice: bm_george
---

## Intent

Hackathon submission video (CockroachDB x AWS "Build with Agentic Memory",
sub-3-minute hard cap, target 2:50). Judges must see: 2+ CockroachDB tools
named and shown, AWS Bedrock + Lambda in use, a working public demo, and the
newly-created + hippo-pedigree disclosure. Tone: engineer-to-engineer, plain,
numbers-led, zero hype. The narration script is LOCKED at
`../docs/video-script.md` (segment timings + shot list + judging-criteria
checklist); scene durations follow the real TTS clip durations, not the
script's nominal timestamps.

## Assets

- ../docs/video-script.md - locked narration + shot list; the edit's source of truth.
- ../docs/dashboard.png - live dashboard still (fallback frame if a capture fails).
- work/captures/*.mp4 (to be recorded) - Playwright recordings of the LIVE demo URL: cross-session chat, memory lifecycle, time travel.
- Live demo: https://7ooxrsy3fga63z5f6dfadv2d3a0vtddf.lambda-url.us-east-1.on.aws/dashboard scope demo.
- Resilience segment source: verbatim phase output from scripts/resilience-demo.ps1 run (2026-08-10), rebuilt as a labelled terminal-replay graphics scene ("local 3-node cluster, output replay") - NOT passed off as a screen recording.

## Customizations

- Voiceover: local Kokoro TTS (`npx hyperframes tts`), male en-gb (bm_george), generated per script segment BEFORE the timeline; overruns re-generated at higher -s per the armsmith recipe. Mux: ffmpeg adelay per clip + amix normalize=0.
- Graphics scenes (title/problem, architecture card, close) in the dashboard's own visual language: #0b0e14 bg, #4ade80 accent, #fbbf24 amber, monospace numerals, 1px #1f2430 borders.
- EXPLAIN excerpt on the architecture card must show the real `vector search ... prefix spans` plan lines.

## Notes

- Known renderer pin gotchas (armsmith 2026-08-09): avoid y/yPercent scene-transform transitions; tl.set hard-kill for exact-boundary exits; vendor gsap locally; grep empty-content elements after DOM+timeline rewrites.
- Honesty rule: the resilience scene carries a visible "local 3-node cluster" label; serverless cannot kill nodes.
- No em dashes in on-screen text.
