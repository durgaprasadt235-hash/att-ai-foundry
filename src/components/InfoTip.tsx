// InfoTip — a small blue circled "i" that carries an explanation.
//
// The screen stays clean (labels, numbers and actions only); the
// explanation lives in the tooltip, not in visible prose. Hover shows
// it on desktop (CSS :hover, desktop pointers only); on touch — the
// user views this on a phone, where hover does not exist — tapping the
// icon toggles it open, tapping again or anywhere else closes it.
// Keep tooltip text to one or two short lines, plain words.
import { useEffect, useRef, useState } from 'react';

export default function InfoTip({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  // Tap-to-toggle: once open, a tap/click anywhere outside (or Escape)
  // closes it. The listener is only attached while open, so the tap
  // that opens it cannot immediately close it again.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span className={`info-tip${open ? ' open' : ''}`} ref={ref}>
      <button
        type="button"
        className="info-tip-btn"
        aria-label={label ?? 'More information'}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        i
      </button>
      <span className="info-tip-bubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}
