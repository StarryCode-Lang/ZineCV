import * as motion from "motion/react-m";

const editorialEase = [0.2, 0.78, 0.25, 1] as const;
const settleEase = [0.22, 1, 0.36, 1] as const;

export const motionTransitions = {
  standard: { type: "tween" as const, duration: 0.24, ease: settleEase },
  interaction: { type: "tween" as const, duration: 0.22, ease: settleEase },
  disclosure: { type: "tween" as const, duration: 0.3, ease: settleEase },
  fade: { type: "tween" as const, duration: 0.2, ease: editorialEase },
  navigation: { type: "tween" as const, duration: 0.36, ease: settleEase },
};

export { motion };
