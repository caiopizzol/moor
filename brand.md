---
name: "moor"
tagline: "Docker control for a single server."
version: 1
language: en
---

# moor

## Strategy

### Overview

Moor is a self-hosted Docker control panel for a single server. It gives you a web UI to build, deploy, and manage containers — with cron jobs, live logs, and a terminal built in.

It was born from a specific frustration: tools like Coolify ship dozens of features you'll never use, then break in ways you can't debug because the platform is between you and Docker. Moor doesn't sit between you and anything. It's a window into what Docker is already doing.

What moor really does is remove the SSH ceremony. You have a VPS. You have containers that need to run — APIs, scrapers, data pipelines, long-running scripts that take days. Moor lets you deploy them from a GitHub repo, watch them build, read their logs, schedule cron inside them, and open a terminal when something goes wrong. That's it.

**The problem it solves:** Running containers on a single server requires either SSHing in every time or learning a platform that's heavier than the thing you're deploying. Moor eliminates both.

**The transformation:**
- **Before:** SSH into your server. `docker build`. `docker run`. Forget what's running. Lose terminal history. Can't check logs without connecting again.
- **After:** Open a browser tab. See everything. Build, deploy, schedule, debug — all in one place. Then close the tab.

**Long-term ambition:** Be the best way to run containers on a single server. Nothing more.

### Positioning

**Category:** Docker control panel for single-server deployments.

Not a PaaS. Not a Heroku alternative. Not a container orchestrator. Not a hosting platform. Moor is a control panel — a thin interface over Docker that shows you what's happening and lets you act on it.

**What moor is NOT:**
- Not a platform-as-a-service. It doesn't abstract Docker away — it surfaces it.
- Not for teams. No RBAC, no multi-user workflows, no audit trails.
- Not for multi-server. One server. That's the scope.
- Not for hosting databases or production web apps. Use managed services for that. Moor is for the workloads that don't fit anywhere else — scrapers, cron jobs, processing pipelines, background workers.
- Not a business. It's open-source software that solves a personal problem.

**Competitive landscape:**
The self-hosted container management space is crowded and confused. Every tool overpromises:

- **Coolify** calls itself a "self-hosting platform with superpowers." Ships 280+ one-click apps, multi-server support, Kubernetes plans. Also ships critical security vulnerabilities and eats 500MB+ of RAM at idle. When it breaks, you're debugging Laravel, not your app.
- **Portainer** abandoned developers to chase enterprise sales. The free tier is a demo. The paid tier is a dashboard that makes you verify everything in the terminal anyway.
- **CapRover** says "It Just Works" but development has stalled. Docker Swarm under the hood. Good for 2019.
- **Dokku** is honest and lightweight, but has no UI. CLI-only.
- **Kamal** is excellent if you're 37signals running Rails on your own hardware. For everyone else, it's opinionated in ways that don't serve you.

**Where moor sits:** Below all of them in scope. Above all of them in focus. These tools try to be a platform. Moor tries to be a control panel. The difference matters — a platform owns your workflow; a control panel shows you what's happening and gets out of the way.

**Structural differentials:**
- **Minimal footprint:** Bun + SQLite. No PHP, no PostgreSQL, no Redis, no multi-service stack eating your VPS resources.
- **Zero abstraction:** Your Dockerfile is the build system. Your container is the runtime. Moor doesn't reinterpret either.
- **Scoped by design:** Single server. Single user. No clustering, no scaling, no features that exist to check a comparison chart box.
- **Real-time visibility:** Streaming build output, live container logs, web terminal. You see exactly what Docker sees.

**The territory moor owns:** The single-server developer who wants eyes and hands on their containers without learning another platform.

### Personality

**Archetype:** The Instrument.

A good instrument doesn't announce itself. It doesn't have a personality. It does what it does with precision and stays out of your way. You pick it up, use it, put it down. The work is yours. The tool just made it easier.

**Attributes:** Minimal. Transparent. Honest. Lightweight. Deliberate.

**What moor is:**
- A control panel, not a platform
- Focused, not feature-rich
- Transparent — you always see what Docker is doing
- Lightweight — runs on the same VPS as your containers
- Opinionated about scope, not about your workflow

**What moor is not:**
- Ambitious — it doesn't want to be a platform
- Clever — no magic, no abstractions, no surprises
- Loud — it doesn't market itself as revolutionary
- Enterprise — no sales team, no pricing tiers, no "contact us"

### Promise

Moor lets you manage Docker containers on a single server from your browser.

You stay in control. Docker is Docker. Moor just gives you eyes and hands.

**Synthesizing phrase:** Moor exists so you never SSH into your server just to check on a container.

### Guardrails

**Tone:** Direct, calm, technical, understated, confident.

**What the brand cannot be:**
- A vendor — moor doesn't sell anything
- A platform — moor doesn't own your workflow
- Aspirational — moor doesn't promise transformation
- Noisy — moor doesn't compete for attention
- Enterprise — moor doesn't speak in acronyms or buzzwords

**Litmus test:** If it could appear on a SaaS landing page with a pricing table, it's wrong.

---

## Voice

### Identity

We're a control panel for Docker on a single server. We show you what's running, let you build and deploy from a GitHub repo, give you a terminal and cron jobs, and stream your logs. That's the whole product.

We don't abstract Docker. We don't replace your Dockerfile with a GUI builder. We don't manage your database, your DNS, your SSL certificates, or your CI pipeline. There are better tools for those things. We do the part that nobody else does well: giving you a clean, fast interface to your containers on one server.

We're open source. We're not a company. We exist because the alternatives were either too heavy or too invisible.

**Essence:** A window into your server.

### Tagline & Slogans

**Primary tagline:** Docker control for a single server.
*Use everywhere: site header, GitHub description, social bios, README.*

**Alternatives:**
- Eyes and hands on your containers.
- The Docker UI that doesn't get in the way.

**Slogans for specific contexts:**
- *README / Getting started:* One server. One dashboard. Full control.
- *Feature comparison:* Everything you need. Nothing you don't.
- *Problem statement:* Self-hosting shouldn't require another platform to learn.
- *Install CTA:* Running in seconds.
- *Why moor exists:* You shouldn't need to SSH in just to check on a container.

### Message Pillars

**Control**
You stay in control. Moor surfaces Docker — it doesn't replace it. Your Dockerfile is your build system. Your container is your runtime. Nothing is reinterpreted.

**Visibility**
See what's happening. Streaming build output, live container logs, server metrics, container status — all in real time, all in one place.

**Simplicity**
Less is the point. Moor runs on Bun and SQLite. It installs in two commands. It doesn't eat your VPS resources or require its own infrastructure.

**Focus**
One server. One user. Containers, cron, logs, terminal. That's the scope. Features exist because they're useful, not because a competitor has them.

### Phrases

- "Your Dockerfile is the build system."
- "Docker is Docker. Moor just gives you a UI."
- "One server. Full control."
- "See what's running. Act on it. Close the tab."
- "A control panel, not a platform."
- "Self-hosting shouldn't mean learning another platform."
- "Two commands to install. Zero commands to manage."
- "The dashboard your VPS deserves."

### Social Bios

**GitHub:**
Self-hosted Docker control panel for a single server. Build, deploy, and manage containers with cron, logs, and a web terminal.

**X/Twitter:**
Docker control panel for a single server. Open source.

**Reddit / Forum:**
moor — a self-hosted Docker control panel. Build from GitHub repos, stream logs, schedule cron, open a terminal. For people who want a UI on their containers without learning a platform. Open source.

### Tonal Rules

**How to communicate:**

1. Speak in short, declarative sentences. Subject-verb-object.
2. Lead with what moor does, not what it promises.
3. Be specific. "Bun + SQLite" is better than "lightweight architecture."
4. Name the alternative when it helps. "Unlike Coolify, moor doesn't..." is fine when the contrast is useful.
5. Technical terms are fine. The audience knows Docker, containers, VPS, cron.
6. No exclamation marks. Confidence is quiet.
7. No superlatives. Not "the best," "the fastest," "the most powerful."
8. No future promises. Don't announce what moor will do. Show what it does.
9. Treat scope as a feature, not a limitation. "Single server" is a design decision, not a compromise.
10. When in doubt, write less.

**Identity boundaries:**

- We are not a company. We don't have a "team" page or a roadmap with quarters.
- We are not a platform. We don't manage your infrastructure.
- We are not competing with Kubernetes. We're not even in the same conversation.
- We are not trying to grow. We're trying to be useful.
- We are not making Docker easier. We're making it visible.

**We Say / We Never Say:**

| We Say | We Never Say |
|---|---|
| "Control panel" | "Platform" |
| "Single server" | "Scale to any size" |
| "See what's running" | "Unlock visibility" |
| "Open source" | "Free tier" |
| "Your Dockerfile" | "Our build pipeline" |
| "Moor shows you" | "Moor empowers you" |
| "Install in two commands" | "Get started in minutes" |
| "For containers on a VPS" | "For modern cloud-native teams" |

---

## Visual

### Colors

**Primary — Near Black**
`#0a0a0a` — Background. The default surface. Almost all of the UI is this color.

**Raised Surface**
`#141414` — Cards, code blocks, elevated elements. Subtle separation without borders.

**Border**
`#252525` — Dividers, container edges. Barely visible. Structure without weight.

**Green — Accent**
`#4ade80` — Status indicators, CTAs, success states, the brand mark. The only color that carries energy. Use sparingly — it means "alive" or "act here."

**Green Dim**
`#2d8a56` — Secondary green for less prominent elements. Code hashes, hover states.

**Red — Error**
`#f87171` — Error states, stopped containers. Never decorative.

**Yellow — In Progress**
`#fbbf24` — Building states, warnings. Transient — indicates something is happening.

**Text**
`#e0e0e0` — Primary text. High contrast against the dark background.

**Text Muted**
`#707070` — Secondary text, descriptions, metadata. Readable but recessive.

**Text Dim**
`#505050` — Tertiary text, timestamps, disabled states. Present but quiet.

**Colors to avoid:**
- Bright blues, purples, or gradients — these signal "SaaS product" or "enterprise."
- White backgrounds — moor is dark-first. There is no light mode.
- Multiple accent colors — green is the only accent. Everything else is grayscale.

### Typography

**Display / UI — Inter**
Weight: 400 (body), 500 (labels), 600 (headings)
Usage: All interface text, marketing copy, section headings. Tight letter-spacing (-0.02em to -0.035em) on headings.

**Monospace — JetBrains Mono**
Weight: 400
Usage: Terminal output, build logs, code blocks, port numbers, container IDs, install commands. Anything that represents system output or developer input.

No serif fonts. No decorative fonts. Two font families total.

### Style

**Design keywords:** Terminal-native, dark, sparse, precise, structural, flat.

**Reference brands:** Linear (information density, dark UI, restraint), Resend (developer-focused minimalism, dark theme, clear hierarchy), Vercel (clean documentation, black/white with a single accent).

**Direction:** The identity communicates control, not decoration. Every visual element should feel like it belongs in a terminal or a well-designed IDE. No illustrations, no gradients, no rounded-everything. Borders are thin. Spacing is generous. Color is functional — green means alive, red means stopped, yellow means working. Everything else is grayscale.

The overall impression should be: someone who knows what they're doing built this for themselves, and it happens to look good because clarity is beautiful.
