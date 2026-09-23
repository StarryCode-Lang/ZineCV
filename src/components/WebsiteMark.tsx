export function WebsiteMark({ url }: { url: string }) {
  // 新网站需要专属标识时，在这里按域名增加一条判断即可。
  const normalized = url.toLowerCase();

  if (normalized.includes("github.com")) {
    return (
      <i
        className="website-logo iconfont icongithub"
        aria-label="GitHub"
        title="GitHub"
      />
    );
  }

  if (normalized.includes("csdn.net")) {
    return (
      <span className="website-logo csdn-logo" aria-label="CSDN" title="CSDN">
        CSDN
      </span>
    );
  }

  return (
    <i
      className="website-logo iconfont icongerenwangzhan"
      aria-label="个人网站"
      title="个人网站"
    />
  );
}
