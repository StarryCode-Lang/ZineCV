import type { ReactNode } from "react";

type WorkspaceHeadingProps = {
  kicker: ReactNode;
  title: ReactNode;
  deck?: ReactNode;
  /** 标题右侧的窄块（如完成度环）。 */
  aside?: ReactNode;
  /** 标题下方整行的动作区（如继续撰写、提交状态）。 */
  actions?: ReactNode;
  titleId?: string;
};

/**
 * 三个工作区共用的顶部块。
 *
 * 位置（距顶 / 左右留白）、字号、行高与分隔线只在 workspace-heading.css 里定义一次，
 * 页面差异只体现在传入的内容上，切换工作区时标题不会跳。
 */
export function WorkspaceHeading({
  kicker,
  title,
  deck,
  aside,
  actions,
  titleId,
}: WorkspaceHeadingProps) {
  return (
    <>
      <header className="workspace-heading" data-workspace-heading>
        <div className="workspace-heading-copy">
          <p className="workspace-heading-kicker">{kicker}</p>
          <h1 className="workspace-heading-title" id={titleId}>
            {title}
          </h1>
          {deck ? <p className="workspace-heading-deck">{deck}</p> : null}
        </div>
        {aside ? <div className="workspace-heading-aside">{aside}</div> : null}
      </header>
      {/* 动作行落在分隔线之下：三页的标题块因此完全等高，切换时不会跳。 */}
      {actions ? (
        <div className="workspace-heading-actions">{actions}</div>
      ) : null}
    </>
  );
}
