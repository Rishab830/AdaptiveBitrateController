# Technical Report: Adaptive Device-to-Device Bitrate Selection

## Abstract

Flux treats WebRTC encoding selection as a sequential decision problem. Network capacity, contention, latency, loss, and decoding health evolve during a stream, while each bitrate decision affects immediate visual quality and subsequent congestion. A tabular Q-learning controller learns a mapping from discretized connection state to one or two simultaneous bitrate levels. Training happens locally from seeded synthetic traces; runtime sessions perform inference only.

## Architecture and privacy

The Vercel application has Server and Client modes. Short-lived API requests exchange SDP and ICE metadata through Redis. Each viewer then establishes a separate encrypted WebRTC peer connection with the server browser. Receiver statistics return over the connection's data channel. No media is sent to Redis or Vercel, and policies remain in browser IndexedDB unless explicitly exported.

Separate peer connections make per-viewer bitrate control possible, at the cost of encoding and uploading one stream per viewer. Version one therefore caps a room at two viewers. TURN is optional for networks on which NAT traversal cannot form a direct path.

## Markov decision process

Every two seconds the environment is represented by bins for available-to-target bandwidth ratio, delivered-to-target ratio, round-trip time, packet loss, jitter, recent freezes, current levels, time since the last switch, and aggregate host headroom. Unsupported browser estimates use an explicit fallback path; measured RTP byte deltas, packet health, and frame health remain authoritative.

There are five joint audio/video levels. A one-viewer table has five actions. A two-viewer table has 25 ordered action pairs, allowing the controller to reason about aggregate upload contention rather than running contradictory independent agents.

The reward is:

`quality reward - freeze/overload penalty - switching penalty - underutilization penalty`

The switching term discourages oscillation and large jumps. The quality and underutilization terms discourage remaining at a low level when the path can sustain more. Impairment is proportional rather than binary: a few isolated dropped frames are tolerated, while concentrated frame loss, long freezes, and material capacity overload receive progressively larger penalties. Three weight sets expose Balanced, Quality, and Stall Avoidant objectives.

## Learning and deployment

Training uses epsilon-greedy tabular Q-learning with learning rate 0.1, discount factor 0.95, and epsilon decaying from 1.0 to 0.05. A seeded generator varies capacity, volatility, RTT, loss, and viewer contention. Tables are sparse maps keyed by the discretized state, making export and inspection straightforward.

An unseen live state invokes a conservative state-based decision and is visibly labelled as a fallback. This is preferable to interpreting an all-zero unseen row as evidence for an arbitrary action. Live inference never mutates an active policy, preserving repeatability.

## Evaluation

The training dashboard reports mean simulated reward, mean level, freeze rate, switch rate, underutilization, and visited state count. Deterministic tests verify state bins, joint-action encoding, reward ordering, Q-table reproducibility, and exact-table versus fallback selection. Signaling tests cover participant limits, authentication, targeted messages, leaving, and slot reuse.

For an experiment, train all three reward modes with the same profile and seed, then repeat the same browser-throttling schedule. Record average delivered bitrate, freeze/frame-drop count, switch count, loss, and RTT from the host dashboard. Expected behavior is higher average levels from Quality and fewer overload events from Stall Avoidant; Balanced should lie between them.

## Limitations and future work

- Browser-reported bandwidth estimates and Network Information hints are not universally available.
- WebRTC has its own congestion controller, so the RL action is an upper bound rather than exact wire bitrate.
- Local media and screen capture support differs by mobile browser.
- Synthetic training traces may not represent every real network or encoder.
- Peer-to-peer fan-out does not scale beyond a small room; larger broadcasts should introduce an SFU.
- Future versions could learn from privacy-preserving session summaries, use function approximation, issue expiring TURN credentials, and synchronize policies across authenticated devices.
