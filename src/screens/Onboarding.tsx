import "../tl-tutor.css";

/**
 * First run is Today-first: Throughline no longer forces an AI chooser before
 * the app is usable. Setup happens at the moment of intent — the first tutor
 * lens click owns it (see `AiSetupSheet`). This component is kept only as a
 * calm, optional one-liner a host screen may show; it is not routed by `App`
 * and it gates nothing.
 *
 * (The old forced "How should AI help you read?" chooser was removed: it asked
 * the privacy question before there was anything to read, and stranded a fresh
 * reader behind a decision they couldn't yet evaluate.)
 */
export default function Onboarding({ onDone }: { onDone?: () => void }) {
  return (
    <div className="tl-onboard">
      <div className="tl-card tl-onboard-card">
        <h1 className="tl-onboard-title">Throughline is ready</h1>
        <p className="tl-onboard-sub">
          You can read without AI. The tutor only runs when you select a passage and ask —
          you choose where it runs the first time you use it.
        </p>
        {onDone && (
          <div className="tl-onboard-actions">
            <button className="tl-btn tl-btn-primary" onClick={onDone}>
              Start reading
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
