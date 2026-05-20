"use client";

import { useEffect, useRef, useState } from "react";

export type PullDirection = "down" | "up";

export type PullState = {
  distance: number; // 0..MAX_PULL
  direction: PullDirection | null;
  releasing: boolean;
  busy: boolean;
};

const THRESHOLD = 70;
const MAX_PULL = 110;
const TOUCH_RESISTANCE = 0.5;
const WHEEL_RESISTANCE = 0.6;
const WHEEL_IDLE_MS = 220;
const WHEEL_RELEASE_MS = 250;

export type PullHandlers = {
  onPullDown?: () => Promise<void> | void;
  onPullUp?: () => Promise<void> | void;
};

export function usePullGestures(
  ref: React.RefObject<HTMLElement | null>,
  handlers: PullHandlers,
) {
  const [state, setState] = useState<PullState>({
    distance: 0,
    direction: null,
    releasing: false,
    busy: false,
  });
  const startYRef = useRef<number | null>(null);
  const directionRef = useRef<PullDirection | null>(null);
  const validRef = useRef(false);
  const distanceRef = useRef(0);
  const busyRef = useRef(false);
  const handlersRef = useRef(handlers);
  const wheelTimerRef = useRef<number | null>(null);
  const lastWheelTimeRef = useRef(0);
  const canPullRef = useRef(false);

  useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    function isAtTop(node: HTMLElement): boolean {
      return node.scrollTop <= 0;
    }
    function isAtBottom(node: HTMLElement): boolean {
      return (
        Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight - 1
      );
    }

    function reset() {
      directionRef.current = null;
      distanceRef.current = 0;
      setState({
        distance: 0,
        direction: null,
        releasing: false,
        busy: false,
      });
    }

    async function release(direction: PullDirection) {
      const handler =
        direction === "down"
          ? handlersRef.current.onPullDown
          : handlersRef.current.onPullUp;
      if (!handler) {
        reset();
        return;
      }
      busyRef.current = true;
      setState({
        distance: 40,
        direction,
        releasing: false,
        busy: true,
      });
      try {
        await handler();
      } finally {
        busyRef.current = false;
        directionRef.current = null;
        distanceRef.current = 0;
        setState({
          distance: 0,
          direction: null,
          releasing: false,
          busy: false,
        });
      }
    }

    // ---- Touch ----
    function tStart(e: TouchEvent) {
      if (busyRef.current) return;
      const node = ref.current;
      if (!node) return;
      const atTop = isAtTop(node);
      const atBottom = isAtBottom(node);
      if (!atTop && !atBottom) {
        validRef.current = false;
        return;
      }
      startYRef.current = e.touches[0].clientY;
      validRef.current = true;
      directionRef.current = null;
      distanceRef.current = 0;
    }

    function tMove(e: TouchEvent) {
      if (!validRef.current || startYRef.current == null) return;
      const node = ref.current;
      if (!node) return;
      const dy = e.touches[0].clientY - startYRef.current;
      const atTop = isAtTop(node);
      const atBottom = isAtBottom(node);
      const wantDown = dy > 0 && atTop && !!handlersRef.current.onPullDown;
      const wantUp = dy < 0 && atBottom && !!handlersRef.current.onPullUp;
      if (!wantDown && !wantUp) {
        if (distanceRef.current !== 0) {
          distanceRef.current = 0;
          directionRef.current = null;
          setState({
            distance: 0,
            direction: null,
            releasing: false,
            busy: false,
          });
        }
        return;
      }
      e.preventDefault();
      const direction: PullDirection = wantDown ? "down" : "up";
      directionRef.current = direction;
      const distance = Math.min(MAX_PULL, Math.abs(dy) * TOUCH_RESISTANCE);
      distanceRef.current = distance;
      setState({
        distance,
        direction,
        releasing: distance >= THRESHOLD,
        busy: false,
      });
    }

    function tEnd() {
      if (!validRef.current) return;
      validRef.current = false;
      startYRef.current = null;
      const dir = directionRef.current;
      const release_ = distanceRef.current >= THRESHOLD && !!dir;
      if (release_) {
        void release(dir!);
      } else {
        reset();
      }
    }

    // ---- Wheel ----
    function wheel(e: WheelEvent) {
      const now = Date.now();
      const gap = now - lastWheelTimeRef.current;
      lastWheelTimeRef.current = now;
      // A new gesture begins only after the wheel has been quiet long
      // enough — this rejects momentum carried over from scrolling to the
      // edge, which would otherwise immediately trigger a pull.
      if (gap > WHEEL_RELEASE_MS) {
        canPullRef.current = true;
      }

      if (busyRef.current) return;
      const node = ref.current;
      if (!node) return;
      const atTop = isAtTop(node);
      const atBottom = isAtBottom(node);
      const wantDown =
        e.deltaY < 0 && atTop && !!handlersRef.current.onPullDown;
      const wantUp =
        e.deltaY > 0 && atBottom && !!handlersRef.current.onPullUp;
      if (!wantDown && !wantUp) {
        // outside of edge — clear any pending gesture
        canPullRef.current = false;
        if (distanceRef.current > 0) {
          if (wheelTimerRef.current) {
            window.clearTimeout(wheelTimerRef.current);
            wheelTimerRef.current = null;
          }
          reset();
        }
        return;
      }
      if (!canPullRef.current) {
        // Still inside the inertia window after reaching the edge —
        // swallow the events but don't accumulate any pull distance.
        return;
      }
      e.preventDefault();
      const direction: PullDirection = wantDown ? "down" : "up";
      if (directionRef.current !== direction) {
        directionRef.current = direction;
        distanceRef.current = 0;
      }
      const distance = Math.min(
        MAX_PULL,
        distanceRef.current + Math.abs(e.deltaY) * WHEEL_RESISTANCE,
      );
      distanceRef.current = distance;
      setState({
        distance,
        direction,
        releasing: distance >= THRESHOLD,
        busy: false,
      });
      if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
      wheelTimerRef.current = window.setTimeout(() => {
        const dir = directionRef.current;
        if (dir && distanceRef.current >= THRESHOLD) {
          void release(dir);
        } else {
          reset();
        }
        canPullRef.current = false;
      }, WHEEL_IDLE_MS);
    }

    el.addEventListener("touchstart", tStart, { passive: true });
    el.addEventListener("touchmove", tMove, { passive: false });
    el.addEventListener("touchend", tEnd);
    el.addEventListener("touchcancel", tEnd);
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      el.removeEventListener("touchstart", tStart);
      el.removeEventListener("touchmove", tMove);
      el.removeEventListener("touchend", tEnd);
      el.removeEventListener("touchcancel", tEnd);
      el.removeEventListener("wheel", wheel);
      if (wheelTimerRef.current) window.clearTimeout(wheelTimerRef.current);
    };
  }, [ref]);

  return state;
}
