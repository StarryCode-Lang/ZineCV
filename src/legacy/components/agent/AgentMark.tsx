import { useEffect, useRef } from "react";

type AgentMarkProps = {
  active?: boolean;
  className?: string;
};

const slabPath =
  "M33 18 L75 0 Q80 -2 85 0 L124 17 Q131 20 131 25 Q131 30 124 33 L83 50 Q78 52 73 50 L33 33 Q25 30 25 25 Q25 20 33 18Z";
const slots = [16, 42, 68];

export function AgentMark({ active = false, className = "" }: AgentMarkProps) {
  const slabRefs = useRef<Array<SVGGElement | null>>([]);
  const nodeRef = useRef<SVGCircleElement | null>(null);
  const shadowRef = useRef<SVGEllipseElement | null>(null);

  useEffect(() => {
    const slabs = slabRefs.current;
    const node = nodeRef.current;
    const shadow = shadowRef.current;
    if (!node || !shadow || slabs.some((slab) => !slab)) return;
    const elements = [...slabs, node, shadow] as SVGElement[];
    const reset = () => {
      elements.forEach((element) =>
        element.getAnimations().forEach((animation) => animation.cancel()),
      );
      slabs.forEach((slab, index) => {
        if (slab) slab.style.transform = `translate(0px, ${slots[index]}px)`;
      });
      node.style.transform = "translate(0px, 0px)";
      shadow.style.transform = "translate(0px, 0px)";
      shadow.style.opacity = ".12";
    };
    reset();
    if (
      !active ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      return reset;
    let cancelled = false;
    const pause = (ms: number) =>
      new Promise<void>((resolve) => window.setTimeout(resolve, ms));
    const animate = (
      element: SVGElement,
      frames: Keyframe[],
      duration: number,
      easing = "cubic-bezier(.45,0,.2,1)",
    ) =>
      element
        .animate(frames, { duration, easing, fill: "forwards" })
        .finished.catch(() => undefined);
    const loop = async () => {
      const order = [0, 1, 2];
      while (!cancelled) {
        const top = slabs[order[0]]!;
        const middle = slabs[order[1]]!;
        const bottom = slabs[order[2]]!;
        await Promise.all([
          animate(
            top,
            [
              { transform: `translate(0px, ${slots[0]}px)` },
              { transform: `translate(18px, ${slots[0] - 4}px)` },
              {
                transform: `translate(34px, ${slots[0] + 4}px)`,
                opacity: 0.92,
              },
            ],
            280,
          ),
          animate(
            shadow,
            [
              { transform: "translate(0px, 0px) scaleX(1)", opacity: 0.12 },
              { transform: "translate(0px, 5px) scaleX(.72)", opacity: 0.06 },
            ],
            280,
          ),
        ]);
        if (cancelled) break;
        await Promise.all([
          animate(
            top,
            [
              {
                transform: `translate(34px, ${slots[0] + 4}px)`,
                opacity: 0.92,
              },
              {
                transform: `translate(30px, ${slots[2] + 12}px)`,
                opacity: 0.48,
              },
              { transform: `translate(0px, ${slots[2]}px)`, opacity: 1 },
            ],
            430,
          ),
          animate(
            middle,
            [
              { transform: `translate(0px, ${slots[1]}px)` },
              { transform: `translate(0px, ${slots[0]}px)` },
            ],
            430,
          ),
          animate(
            bottom,
            [
              { transform: `translate(0px, ${slots[2]}px)` },
              { transform: `translate(0px, ${slots[1]}px)` },
            ],
            430,
          ),
          animate(
            node,
            [
              { transform: "translate(0px, 0px) scale(1)" },
              { transform: "translate(0px, 17px) scale(.96)" },
              { transform: "translate(0px, 12px) scale(1.03)" },
              { transform: "translate(0px, 14px) scale(1)" },
            ],
            430,
            "cubic-bezier(.3,.8,.25,1.15)",
          ),
          animate(
            shadow,
            [
              { transform: "translate(0px, 5px) scaleX(.72)", opacity: 0.06 },
              { transform: "translate(0px, 15px) scaleX(1.15)", opacity: 0.2 },
              { transform: "translate(0px, 13px) scaleX(.92)", opacity: 0.13 },
            ],
            430,
          ),
        ]);
        if (cancelled) break;
        await pause(180);
        if (cancelled) break;
        await Promise.all([
          animate(
            node,
            [
              { transform: "translate(0px, 14px)" },
              { transform: "translate(0px, -2px)" },
              { transform: "translate(0px, 0px)" },
            ],
            240,
            "cubic-bezier(.22,.8,.3,1)",
          ),
          animate(
            shadow,
            [
              { transform: "translate(0px, 13px) scaleX(.92)", opacity: 0.13 },
              { transform: "translate(0px, 0px) scaleX(1)", opacity: 0.12 },
            ],
            240,
          ),
        ]);
        if (cancelled) break;
        elements.forEach((element) =>
          element.getAnimations().forEach((animation) => animation.cancel()),
        );
        order.push(order.shift()!);
        slabs[order[0]]!.style.transform = `translate(0px, ${slots[0]}px)`;
        slabs[order[1]]!.style.transform = `translate(0px, ${slots[1]}px)`;
        slabs[order[2]]!.style.transform = `translate(0px, ${slots[2]}px)`;
        node.style.transform = "translate(0px, 0px)";
        shadow.style.transform = "translate(0px, 0px)";
        await pause(120);
      }
    };
    void loop();
    return () => {
      cancelled = true;
      reset();
    };
  }, [active]);

  return (
    <svg
      className={`agent-stack-mark ${className}`.trim()}
      viewBox="0 0 160 138"
      aria-hidden="true"
      focusable="false"
    >
      {slots.map((slot, index) => (
        <g
          key={index}
          ref={(element) => {
            slabRefs.current[index] = element;
          }}
          className="agent-stack-slab"
          style={{ transform: `translate(0px, ${slot}px)` }}
        >
          <path d={slabPath} fill="#111820" />
        </g>
      ))}
      <ellipse
        ref={shadowRef}
        className="agent-stack-node-shadow"
        cx="112"
        cy="32"
        rx="12"
        ry="4.8"
        fill="#111820"
      />
      <circle
        ref={nodeRef}
        className="agent-stack-node"
        cx="112"
        cy="16"
        r="12"
        fill="#ff6b2c"
      />
    </svg>
  );
}
