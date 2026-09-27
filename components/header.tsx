import Link from "next/link";

export function Header() {
  return (
    <header className="topbar">
      <Link className="brand" href="/"><span className="brand-mark">F</span> Flux</Link>
      <nav><Link href="/host">Server</Link><Link href="/viewer">Client</Link><Link href="/train">Policies</Link></nav>
    </header>
  );
}
