/** Motion tokens shared by the sidecar, Pulse and Trace surfaces. */
export const motionTokens = {
  duration: { instant: 90, fast: 140, state: 220, deliberate: 420, presence: 900 },
  easing: {
    standard: "cubic-bezier(0.2, 0.8, 0.2, 1)",
    enter: "cubic-bezier(0.16, 1, 0.3, 1)",
    exit: "cubic-bezier(0.7, 0, 0.84, 0)",
  },
  spring: { cursorStiffness: 0.13, cursorDamping: 0.78, cursorMaxStep: 42 },
  telemetryHz: 24,
} as const;

export type MotionState = "idle" | "listening" | "thinking" | "speaking" | "acting" | "waiting" | "paused" | "error" | "complete";
