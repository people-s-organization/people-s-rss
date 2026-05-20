"use client";

import { useEffect, useRef, useState } from "react";

type PullState = {
  distance: number;
  releasing: boolean;
  refreshing: boolean;
};

const THRESHOLD = 70;
const MAX_PULL = 110;
const RESISTANCE = 0.5;

export function usePullToRefresh(
  ref: React.RefObject<HTMLElement | null>,
  onRefresh: () => Promise<void> | void,
) {
  const [state, setState] = useState<PullState>({
    distance: 0,
    releasing: false,
    refreshing: false,
  });
  const startYRef = useRef<number | null>(null);
  const validRef = useRef(false);
  const distanceRef = useRef(0);
  const refreshingRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Touch only — desktop scroll & wheel intentionally not hijacked
    const isTouch = typeof window !== "undefined" && "ontouchstart" in window;
    if (!isTouch) return;

    function start(e: TouchEvent) {
      if (refreshingRef.current) return;
      const node = ref.current;
      if (!node) return;
      if (node.scrollTop > 0) {
        validRef.current = false;
        return;
      }
      startYRef.current = e.touches[0].clientY;
      validRef.current = true;
      distanceRef.current = 0;
    }

    function move(e: TouchEvent) {
      if (!validRef.current || startYRef.current == null) return;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy <= 0) {
        if (distanceRef.current !== 0) {
          distanceRef.current = 0;
          setState({ distance: 0, releasing: false, refreshing: false });
        }
        return;
      }
      e.preventDefault();
      const distance = Math.min(MAX_PULL, dy * RESISTANCE);
      distanceRef.current = distance;
      setState({
        distance,
        releasing: distance >= THRESHOLD,
        refreshing: false,
      });
    }

    async function end() {
      if (!validRef.current) return;
      validRef.current = false;
      startYRef.current = null;
      const release = distanceRef.current >= THRESHOLD;
      distanceRef.current = 0;
      if (release) {
        refreshingRef.current = true;
        setState({ distance: 40, releasing: false, refreshing: true });
        try {
          await onRefreshRef.current();
        } finally {
          refreshingRef.current = false;
          setState({ distance: 0, releasing: false, refreshing: false });
        }
      } else {
        setState({ distance: 0, releasing: false, refreshing: false });
      }
    }

    el.addEventListener("touchstart", start, { passive: true });
    el.addEventListener("touchmove", move, { passive: false });
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
    return () => {
      el.removeEventListener("touchstart", start);
      el.removeEventListener("touchmove", move);
      el.removeEventListener("touchend", end);
      el.removeEventListener("touchcancel", end);
    };
  }, [ref]);

  return state;
}
