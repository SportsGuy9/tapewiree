"use client";

import { useEffect } from "react";

export interface TourStep {
  target: string; // element id
  caption: string;
  onEnter?: () => void;
}

/** Four-step guided tour: fixed bottom sheet (one-handed on a phone) + outline on the target. */
export function Tour({ steps, step, setStep, onClose }: { steps: TourStep[]; step: number; setStep: (n: number) => void; onClose: () => void }) {
  const s = steps[step];
  useEffect(() => {
    s.onEnter?.();
    const t = window.setTimeout(() => {
      const el = document.getElementById(s.target);
      if (!el) return;
      el.classList.add("tour-hl");
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
    return () => {
      window.clearTimeout(t);
      document.getElementById(s.target)?.classList.remove("tour-hl");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && step < steps.length - 1) setStep(step + 1);
      if (e.key === "ArrowLeft" && step > 0) setStep(step - 1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [step, steps.length, setStep, onClose]);
  const last = step === steps.length - 1;
  return (
    <div
      role="dialog"
      aria-label="Guided tour"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-line bg-panel shadow-[0_-4px_16px_rgba(0,0,0,0.12)]"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      <div className="mx-auto max-w-3xl px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <span className="num text-xs text-muted">Step {step + 1} of {steps.length}</span>
          <button onClick={onClose} aria-label="Close tour" className="min-h-[44px] min-w-[44px] rounded text-lg text-muted hover:bg-surface">✕</button>
        </div>
        <p className="mb-3 text-base font-medium leading-snug" aria-live="polite">{s.caption}</p>
        <div className="flex gap-2">
          <button className="btn min-h-[48px] flex-1 justify-center text-base" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          <button className="btn-primary min-h-[48px] flex-[2] justify-center text-base" onClick={() => (last ? onClose() : setStep(step + 1))}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
