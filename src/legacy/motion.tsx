import type { PropsWithChildren } from "react";
import { LazyMotion, MotionConfig, domMax } from "motion/react";
import { useMotionUI } from "./motion/useMotionUI";
import { motionTransitions } from "./motion/primitives";

export function AppMotionProvider({ children }: PropsWithChildren) {
  useMotionUI();
  return (
    <MotionConfig reducedMotion="user" transition={motionTransitions.standard}>
      <LazyMotion features={domMax} strict>
        {children}
      </LazyMotion>
    </MotionConfig>
  );
}
