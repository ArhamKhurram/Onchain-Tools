/** CSS 3D crystal — stope-inspired centerpiece without WebGL. */
export function CrystalVisual() {
  return (
    <div className="crystal-scene pointer-events-none" aria-hidden>
      <div className="crystal-body">
        <div className="crystal-face crystal-face-1" />
        <div className="crystal-face crystal-face-2" />
        <div className="crystal-face crystal-face-3" />
        <div className="crystal-face crystal-face-4" />
        <div className="crystal-face crystal-face-5" />
        <div className="crystal-face crystal-face-6" />
        <div className="crystal-face crystal-face-7" />
        <div className="crystal-face crystal-face-8" />
      </div>
    </div>
  );
}
