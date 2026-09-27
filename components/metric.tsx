export function Metric({ label, value, tone }: { label: string; value: string | number; tone?: "good" | "warn" }) {
  return <div className={`metric ${tone ?? ""}`}><span>{label}</span><strong>{value}</strong></div>;
}
