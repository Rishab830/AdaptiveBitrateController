# Flux — Adaptive P2P Bitrate Selector

Flux is a direct device-to-device streaming website controlled by tabular Q-learning. One device opens **Server Mode**, chooses a local video, camera, or screen, and shares a six-character room code. Up to two devices join in **Client Mode**. Media is encrypted and sent with WebRTC; it is never uploaded to the application server.

## What is implemented

- Direct WebRTC audio/video with one host and up to two viewers.
- Per-viewer WebRTC telemetry returned over a data channel.
- Joint one/two-viewer bitrate actions applied with `RTCRtpSender.setParameters()`.
- Browser-local Q-learning in a Web Worker with Balanced, Quality, and Stall Avoidant rewards.
- IndexedDB policy storage plus JSON import/export.
- Expiring, token-scoped signaling rooms using Upstash Redis in production.
- In-memory signaling fallback for single-process local development.
- Responsive host, viewer, and policy-training dashboards.
- Optional TURN relay configuration.

## Local development

Requirements: Node.js 20.9 or newer and a modern browser.

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. To test across physical devices, serve the development site over HTTPS or deploy it to Vercel; camera, microphone, and screen APIs require a secure context outside localhost.

Without Redis, rooms live only in the memory of one Next.js process. That is convenient locally but unsuitable for a multi-instance deployment.

## Vercel deployment

1. Create an Upstash Redis database through the Vercel Marketplace or Upstash console.
2. Configure `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` in the Vercel project. See `.env.example`.
3. Optionally configure `TURN_URL`, `TURN_USERNAME`, and `TURN_CREDENTIAL`. Public STUN is used when TURN is absent, but restrictive NAT/firewall combinations may then fail.
4. Import the repository into Vercel and use the default Next.js build settings.

Vercel stores and forwards SDP/ICE signaling metadata only. WebRTC media does not travel through the API routes. A configured TURN server can relay encrypted packets when a direct route is unavailable, but Flux does not record or persist them.

## Demonstration

1. Open **Policies** and train one-viewer and/or two-viewer policies. The newest compatible policy is selected automatically; **Activate** pins a preferred policy.
2. Open **Server**, select a local file, camera, or screen, and create a room.
3. Open **Client** on another device and enter the room code. Repeat for a second viewer if desired.
4. Use browser network throttling or different physical networks to observe the host dashboard change per-viewer quality every two seconds.
5. The decision panel identifies whether a Q-table entry or the conservative unseen-state fallback made the decision.

The Server dashboard's **Adaptation mode** control switches between Balanced RL, Quality RL, Stall Avoidant RL, and Manual quality. A compatible trained table is preferred. When one is unavailable, the selected safety controller probes upward after stable delivery instead of remaining permanently at Economy; Manual quality applies the selected level directly.

Ending a room displays a termination dialog to every viewer. Viewer tabs send a leave beacon during refresh/close, while heartbeat expiry releases a slot if the browser cannot deliver that beacon.

Local-file capture and screen sharing are capability-dependent. The UI reports unsupported capture rather than uploading or transcoding the file. Camera/microphone sources generally have the broadest mobile support.

## Quality levels

| Level | Video | Max resolution/FPS | Audio |
|---|---:|---:|---:|
| Economy | 250 Kbps | 360p/15 | 32 Kbps |
| Low | 600 Kbps | 480p/24 | 48 Kbps |
| Medium | 1.2 Mbps | 720p/30 | 64 Kbps |
| High | 2.5 Mbps | 1080p/30 | 96 Kbps |
| Ultra | 4.5 Mbps | 1080p/60 | 128 Kbps |

Browsers may further constrain an encoder. Flux checks source capabilities, masks unsuitable levels, and falls back to video track constraints when an encoding parameter is ignored.

## Commands

```bash
npm run lint
npm test
npm run build
```

With the development server running, `npm run test:webrtc` launches two local Chromium pages with a synthetic camera and verifies room joining, ICE connection, and received video. Set `CHROME_PATH` if Chrome or Edge is installed in a nonstandard location.

See [PLAN.md](./PLAN.md) for the product specification and [REPORT.md](./REPORT.md) for the MDP, reward, and architectural rationale.
