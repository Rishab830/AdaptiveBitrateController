import Link from "next/link";
import { Header } from "@/components/header";

export default function Home() {
  return (
    <main>
      <Header />
      <section className="hero shell">
        <div className="eyebrow"><i /> PRIVATE BY DESIGN · RL POWERED</div>
        <h1>Stream directly.<br /><em>Adapt intelligently.</em></h1>
        <p className="lead">Flux sends live media straight from one device to another. A tabular Q-learning policy continuously balances clarity, stability, and bandwidth—without uploading your video.</p>
        <div className="role-grid">
          <Link className="role-card warm" href="/host">
            <span className="role-icon">◉</span><small>SERVER MODE</small><h2>Host a stream</h2>
            <p>Choose a file, camera, or screen. Create a private room for up to two viewers.</p><b>Start hosting →</b>
          </Link>
          <Link className="role-card cool" href="/viewer">
            <span className="role-icon">↗</span><small>CLIENT MODE</small><h2>Join a stream</h2>
            <p>Enter a six-character room code and receive a bitrate tailored to your connection.</p><b>Join a room →</b>
          </Link>
        </div>
        <div className="feature-strip">
          <span><b>01</b> Peer-to-peer media</span><span><b>02</b> Per-viewer adaptation</span><span><b>03</b> Local Q-table training</span>
        </div>
      </section>
    </main>
  );
}
