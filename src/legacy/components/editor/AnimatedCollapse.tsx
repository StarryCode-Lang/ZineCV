import { AnimatePresence, useIsPresent, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { motion, motionTransitions } from "../../motion/primitives";

function CollapseContent({
  children,
  open,
}: {
  children: ReactNode;
  open: boolean;
}) {
  const isPresent = useIsPresent();
  const reducedMotion = useReducedMotion();
  const visible = open && isPresent;

  return (
    <motion.div
      aria-hidden={!visible}
      inert={!visible}
      initial={reducedMotion ? false : { height: 0, opacity: 0 }}
      // AnimatePresence keeps this node mounted during exit. Drive the same
      // measured height animation from `visible` so the closing state follows
      // the exact reverse path on every layout, including rapid toggles.
      animate={
        visible ? { height: "auto", opacity: 1 } : { height: 0, opacity: 0 }
      }
      exit={{ height: 0, opacity: 0 }}
      transition={
        reducedMotion
          ? { duration: 0 }
          : {
              height: motionTransitions.disclosure,
              opacity: motionTransitions.fade,
            }
      }
      style={{ width: "100%", minHeight: 0, overflow: "hidden" }}
    >
      {children}
    </motion.div>
  );
}

export function AnimatedCollapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <CollapseContent key="content" open={open}>
          <div className={className}>{children}</div>
        </CollapseContent>
      ) : null}
    </AnimatePresence>
  );
}
