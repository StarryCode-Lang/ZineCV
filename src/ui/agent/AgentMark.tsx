import { useId } from "react";

// ZineBot 的标记：奶白圆盘里坐着一只小机器人——深色面罩、两只发光的眼睛、橙色天线球。
// 三种状态（idle / hover / running）全部交给 CSS，组件本身无副作用。
type AgentMarkProps = {
  active?: boolean;
  className?: string;
};

export function AgentMark({ active = false, className = "" }: AgentMarkProps) {
  const rawId = useId();
  const uid = rawId.replace(/[^a-zA-Z0-9_-]/g, "");
  const helmetId = `zinebot-helmet-${uid}`;
  const visorId = `zinebot-visor-${uid}`;
  const tipId = `zinebot-tip-${uid}`;
  const glowId = `zinebot-glow-${uid}`;

  return (
    <svg
      className={`agent-mark ${active ? "is-running" : ""} ${className}`.trim()}
      viewBox="0 0 96 96"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={helmetId} x1="0.2" y1="0.1" x2="0.8" y2="1">
          <stop offset="0" stopColor="#fffcf6" />
          <stop offset="0.55" stopColor="#fbeade" />
          <stop offset="1" stopColor="#f2d9c6" />
        </linearGradient>
        <linearGradient id={visorId} x1="0.3" y1="0" x2="0.7" y2="1">
          <stop offset="0" stopColor="#332924" />
          <stop offset="1" stopColor="#1d1714" />
        </linearGradient>
        <radialGradient id={tipId} cx="0.35" cy="0.3" r="0.75">
          <stop offset="0" stopColor="#ff9a6b" />
          <stop offset="0.6" stopColor="#f4622f" />
          <stop offset="1" stopColor="#dd4319" />
        </radialGradient>
        <radialGradient id={glowId} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffb888" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffb888" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g
        className="agent-mark-scale"
        transform="translate(48 48) scale(1.15) translate(-48 -48)"
      >
      {/* 底座阴影：让头看起来是坐着的，而不是浮着 */}
      <ellipse className="agent-mark-ground" cx="48" cy="76" rx="23" ry="3.6" />

      <g className="agent-mark-body">
        {/* 身后的橙色披风，只在右侧露出一角 */}
        <path
          className="agent-mark-cape"
          d="M64 40c11 2.5 16 12 15.5 22-.4 8-5.6 13.5-13.5 15.8L64 40Z"
        />

        {/* 天线：从头的后上方斜出，先画，被头挡住根部 */}
        <g className="agent-mark-antenna">
          <path className="agent-mark-stem" d="M63 31 72.5 17.5" />
          <circle
            className="agent-mark-tip"
            fill={`url(#${tipId})`}
            cx="74.5"
            cy="15"
            r="7.2"
          />
          <circle
            className="agent-mark-tip-glint"
            cx="72.5"
            cy="12.5"
            r="1.9"
          />
        </g>

        <g className="agent-mark-face">
          <path
            className="agent-mark-helmet"
            fill={`url(#${helmetId})`}
            d="M48 22c15.5 0 28 10 28 21.5v11c0 12-12.5 19.5-28 19.5s-28-7.5-28-19.5v-11C20 32 32.5 22 48 22Z"
          />
          <rect
            className="agent-mark-visor"
            fill={`url(#${visorId})`}
            x="25.5"
            y="31"
            width="45"
            height="34"
            rx="15.5"
          />
          <g className="agent-mark-eyes">
            <ellipse fill={`url(#${glowId})`} cx="41" cy="49" rx="8" ry="11" />
            <ellipse fill={`url(#${glowId})`} cx="57" cy="49" rx="8" ry="11" />
            <rect
              className="agent-mark-eye"
              x="37"
              y="41"
              width="8"
              height="16"
              rx="4"
            />
            <rect
              className="agent-mark-eye"
              x="53"
              y="41"
              width="8"
              height="16"
              rx="4"
            />
          </g>
        </g>

        {/* 左上角两道橙色小斜线：表示“有反应” */}
        <g className="agent-mark-spark">
          <path d="M28 27 22 17" />
          <path d="M17 33 11 23" />
        </g>
      </g>
      </g>

      {/* 内圈细环：静止时是参考图里的描边，输出中变成转动的虚线 */}
      <circle className="agent-mark-ring" cx="48" cy="48" r="40.5" />
      <circle className="agent-mark-ring-active" cx="48" cy="48" r="40.5" />
    </svg>
  );
}
