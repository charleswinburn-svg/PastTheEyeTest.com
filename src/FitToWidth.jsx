import { useRef, useState, useLayoutEffect } from "react";

// Scales a fixed-width "card" down to fit the available width so nothing is ever
// clipped on mobile / at high zoom, while leaving the card's own layout untouched.
//
// The transform is applied to an ANCESTOR of the card (this inner div), never to
// the cardRef element itself. That keeps the card's own layout at full design
// width, but html2canvas sizes its capture from the element's on-screen
// (post-transform) bounding rect — so the PNG exporter must neutralize this
// wrapper's transform for the duration of the capture. It finds this div via the
// `data-ptet-fit` marker and restores the transform immediately after (see
// saveCardAsPng in baseball/SharedComponents.jsx and the hockey inline saveCard).
//
// When the available width >= designWidth the scale is 1 and the card renders at
// its natural size, centered — pixel-identical to a plain `margin: 0 auto` card.
export default function FitToWidth({ designWidth, children }) {
  const outerRef = useRef(null);
  const innerRef = useRef(null);
  const [{ scale, left, height }, set] = useState({ scale: 1, left: 0, height: undefined });

  useLayoutEffect(() => {
    const outer = outerRef.current, inner = innerRef.current;
    if (!outer || !inner) return;
    const measure = () => {
      const avail = outer.clientWidth;
      const s = Math.min(1, avail / designWidth);
      // offsetHeight is the natural (un-transformed) height; reserve scaled height
      // so the flow below the card isn't left with a gap (or overlapped).
      set({ scale: s, left: (avail - designWidth * s) / 2, height: inner.offsetHeight * s });
    };
    measure();
    // outer → width changes (viewport resize, rotation, desktop Ctrl-+/− zoom);
    // inner → height changes (async content: distributions/images loading).
    const ro = new ResizeObserver(measure);
    ro.observe(outer);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [designWidth]);

  return (
    <div ref={outerRef} style={{ position: "relative", width: "100%", height, overflow: "hidden" }}>
      <div
        ref={innerRef}
        data-ptet-fit=""
        style={{
          position: "absolute",
          top: 0,
          left,
          width: designWidth,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {children}
      </div>
    </div>
  );
}
