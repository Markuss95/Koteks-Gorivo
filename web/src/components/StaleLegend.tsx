/** Explains the dimmed rows: machines with no recent LiDAT report. */
export function StaleLegend() {
  return (
    <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
      <span className="stale-swatch" /> Zasivljeni strojevi nisu poslali LiDAT izvještaj dulje od 10
      dana.
    </div>
  );
}
