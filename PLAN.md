# Direct Adaptive Streaming with Tabular Q-Learning

## Summary

Replace `PLAN.md` with a browser-based, device-to-device streaming product requiring no Docker, media upload, Python service, FFmpeg, or HLS server.

The website will have two roles:

- **Server Mode:** selects a local file, camera/microphone, or screen source and broadcasts it.
- **Client Mode:** joins a room and watches the live stream.

The site will be deployed to Vercel. WebRTC will carry media directly from the server device to as many as two client devices. Vercel and Redis will handle only temporary connection signaling; video and audio will never be uploaded or stored.

## Architecture and Product Behavior

### Web application

- Use Next.js, React, and TypeScript with responsive desktop and mobile interfaces.
- Provide a role-selection landing page for Server Mode and Client Mode.
- Use capability detection so unsupported capture sources are hidden with an explanation.
- Support:
  - Local video-file playback and capture where the browser exposes media capture.
  - Camera and microphone through `getUserMedia()`.
  - Screen and optional system audio through `getDisplayMedia()`.
- Server Mode controls play, pause, seeking, source changes, and session termination.
- Clients join the server’s current live position and cannot seek into media that was never transmitted.
- Support two simultaneous clients through separate `RTCPeerConnection` instances.
- Create a separate adaptive encoding configuration for each client.
- Target current desktop and mobile browsers, while treating individual source types as capability-dependent because local-media and screen capture are not consistently exposed on every mobile browser.
- Show actionable permission, unsupported-browser, disconnected-peer, and source-ended states.

### Rooms, signaling, and connectivity

- Create six-character expiring room codes. Entering a valid code immediately joins without server approval.
- Use Vercel HTTP API routes and short polling for SDP offers, answers, and ICE candidates.
- Persist only short-lived signaling records in Upstash Redis:
  - Room and signal TTL: two hours.
  - Maximum two active client slots.
  - Host receives a private management token.
  - Clients receive scoped participant tokens.
- Rate-limit room creation, join attempts, and signaling writes.
- Delete signaling data when the host ends a session; allow TTL cleanup after an unexpected disconnect.
- Use public STUN servers by default.
- Support optional TURN configuration through Vercel environment variables. TURN may relay encrypted packets when a direct path is impossible but must never store media.
- No media bytes, selected files, Q-tables, or session recordings pass through Vercel or Redis.

### WebRTC bitrate actions

Use five joint audio/video actions:

| Level | Video target | Maximum output | Frame rate | Audio target |
|---|---:|---:|---:|---:|
| Economy | 250 Kbps | 360p | 15 fps | 32 Kbps |
| Low | 600 Kbps | 480p | 24 fps | 48 Kbps |
| Medium | 1.2 Mbps | 720p | 30 fps | 64 Kbps |
| High | 2.5 Mbps | 1080p | 30 fps | 96 Kbps |
| Ultra | 4.5 Mbps | 1080p | 60 fps | 128 Kbps |

- Apply decisions with `RTCRtpSender.setParameters()` using `maxBitrate`, `maxFramerate`, and `scaleResolutionDownBy`.
- Use track constraints as a resolution fallback where browsers do not apply `scaleResolutionDownBy`.
- Mask actions exceeding the source resolution, source frame rate, encoder capability, or device capability.
- Verify the parameters after applying them and record unsupported audio/video controls.
- Keep audio at the nearest supported encoder rate when a browser ignores dynamic audio bitrate changes.

## RL Design and Interfaces

### State and telemetry

Run an adaptation cycle every two seconds. Server-side WebRTC statistics and client telemetry sent over a reliable data channel will include:

- Server device:
  - Actual outbound bitrate and bytes sent.
  - Estimated available outgoing bitrate when exposed.
  - Round-trip time and retransmissions.
  - Encoder time, frames encoded, frames dropped, and quality-limitation reason.
  - Aggregate target and measured upload across both clients.
  - Optional `navigator.connection` network type, downlink estimate, and RTT.
- Client device:
  - Actual inbound bitrate.
  - Packet loss, jitter, retransmission requests, and decode time.
  - Jitter-buffer delay, dropped frames, freezes, and rendered frame rate.
  - Optional client network type, downlink estimate, and RTT.

Missing non-standard estimates will map to explicit `unknown` state bins. The algorithm will rely primarily on measured WebRTC path statistics instead of assuming browsers can reveal exact ISP bandwidth.

Discretize the state using:

- Available-bandwidth-to-current-target ratio.
- Delivered-bitrate-to-target ratio.
- RTT, jitter, and packet-loss bins.
- Recent freeze or severe frame-drop flag.
- Current bitrate level.
- Time since the last bitrate change.
- Aggregate host-upload headroom.
- Host and client connection-type hints, including `unknown`.

### Q-learning controller

- Train sparse tabular Q-tables in a Web Worker so the UI remains responsive.
- Store policy profiles, training results, and active tables in IndexedDB.
- Allow JSON import/export for moving a trained Q-table to another server device.
- Keep active tables immutable during streaming; live sessions perform inference only.
- Train separate one-client and two-client policies.
- For two clients, use a joint action containing both bitrate levels, giving 25 possible action pairs. This lets the policy account for shared server upload rather than making two conflicting independent decisions.
- Give both clients equal weight in the aggregate reward.
- Use epsilon-greedy Q-learning with defaults:
  - Learning rate: `0.1`
  - Discount factor: `0.95`
  - Epsilon: `1.0` decaying to `0.05`
  - Episodes: `10,000`
  - Deterministic configurable seed
- Generate synthetic episodes representing changing server uplink, client downlink, latency, loss, jitter, device encoding limits, and one/two-client contention.
- Include constrained mobile, unstable wireless, and stable broadband starter profiles.

Retain three QoE objectives:

- **Balanced:** quality `1.0`, freezes `4.0`, switching `0.5`, underutilization `0.5`
- **Quality:** quality `1.4`, freezes `2.5`, switching `0.25`, underutilization `0.8`
- **Stall avoidant:** quality `0.8`, freezes `6.0`, switching `0.5`, underutilization `0.25`

Reward high delivered quality while penalizing:

- Freezes, severe frame drops, and excessive latency.
- Large or frequent bitrate changes.
- Staying below a sustainably available bitrate.
- Selecting targets that overcommit aggregate server upload.

### Application interfaces

- Server dashboard:
  - Source preview and playback controls.
  - Room code and connected-client list.
  - Per-client bitrate, RTT, loss, jitter, frame health, and QoE.
  - Aggregate server upload and encoding load.
  - Current discrete state, selected joint action, Q-value, and reason for masked actions.
- Client dashboard:
  - Live player.
  - Connection status, current bitrate, latency, loss, and freeze count.
  - Compact mobile layout and fullscreen playback.
- Training dashboard:
  - Network-profile editor.
  - Reward-mode selection.
  - Training progress and cancellation.
  - Held-out evaluation results.
  - Policy activation, deletion, import, and export.
- Signaling API:
  - `POST /api/rooms`
  - `POST /api/rooms/:code/join`
  - `POST /api/rooms/:code/signals`
  - `GET /api/rooms/:code/signals?cursor=...`
  - `DELETE /api/rooms/:code`
  - `GET /api/ice-config`
- Define versioned TypeScript interfaces for signaling envelopes, client telemetry, discretized states, joint actions, training profiles, evaluation summaries, and exported Q-table artifacts.

## Testing and Documentation

- Unit-test state discretization, reward calculations, action masking, Q-updates, epsilon decay, sparse serialization, synthetic traces, and joint-action selection.
- Test that switching penalties reduce oscillation and underutilization penalties prevent a policy from remaining unnecessarily at low quality.
- Test Redis TTLs, participant limits, token scope, room-code collision handling, signaling cursors, rate limits, and cleanup.
- Integration-test WebRTC negotiation, ICE trickling, data-channel telemetry, adaptive sender parameters, disconnect/reconnect, source replacement, late joining, and two-client contention.
- Browser-test desktop and mobile layouts using capability mocks, with manual real-device checks for Chrome, Edge, Safari, Android, and iOS.
- Verify through network inspection that media travels through WebRTC and never through Vercel API routes.
- Acceptance criteria:
  - One server can stream to two clients without uploading the source media.
  - Each client can receive a different bitrate.
  - Every adaptation is attributable to a Q-table state/action.
  - Both endpoints contribute measurable connection data when available.
  - The stream remains functional when optional network-information fields are absent.
  - Identical seeds reproduce training results.
  - The project runs with `npm install` and `npm run dev` and deploys through a standard Vercel build.
- Include a README and technical report covering deployment, Redis/TURN configuration, architecture, privacy, MDP design, reward modes, experiments, browser limitations, and demonstration steps.

## Assumptions and Deferred Questions

- No Docker, native companion application, FastAPI, FFmpeg, HLS packaging, media uploads, authentication accounts, recording, or online learning are included.
- Server Mode refers to the broadcasting browser, not a conventional media backend.
- Exact ISP bandwidth cannot be read reliably from a browser; measured WebRTC statistics and optional connection hints are the RL inputs.
- Mobile support uses capability-based source availability. `captureStream()` and screen capture are not universally available ([MDN media capture](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/captureStream), [MDN screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)).
- Dynamic WebRTC encoding parameters use compatibility fallbacks because individual settings vary across browsers ([MDN `setParameters`](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/setParameters)).

No blocking v1 questions remain. Questions for a later version are:

1. Should policies and session metrics eventually sync across devices through user accounts?
2. Should clients be able to request playback controls or communicate with the server?
3. Should a later version add encrypted recording or replay?
4. Should scaling beyond two clients use a dedicated SFU rather than direct peer connections?
