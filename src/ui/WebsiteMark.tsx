function websiteHostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // 无 scheme 的裸域名输入按主机名解析，避免子串误匹配。
    return url.toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").split("/")[0];
  }
}

export function WebsiteMark({ url }: { url: string }) {
  // 新网站需要专属标识时，在这里按域名增加一条判断即可。
  const hostname = websiteHostname(url);
  const isSite = (base: string) =>
    hostname === base || hostname.endsWith(`.${base}`);

  if (isSite("github.com") || isSite("github.io")) {
    return (
      <i
        className="website-logo iconfont icongithub"
        aria-label="GitHub"
        title="GitHub"
      />
    );
  }

  if (isSite("csdn.net")) {
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
