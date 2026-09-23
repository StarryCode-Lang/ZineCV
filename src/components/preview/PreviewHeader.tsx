import type { BasicInfo } from "../../domain/resume-model";
import { calculateAge } from "../../utils/resume";
import { WebsiteMark } from "../WebsiteMark";

// 个人信息严格按三行布局，并为右侧证件照保留固定空间。
export function PreviewHeader({ basic }: { basic: BasicInfo }) {
  const age = calculateAge(basic.birth);
  const extra = [
    basic.gender,
    basic.height,
    basic.weight,
    basic.ethnicity,
    basic.birthplace,
    basic.politicalStatus,
    basic.maritalStatus,
    basic.zodiac,
    basic.mbti,
  ].filter(Boolean);
  const sites = [basic.website, basic.linkedin].filter(Boolean) as string[];
  const primaryContacts = [
    { value: basic.phone, icon: "icondianhua2" },
    { value: basic.email, icon: "iconyouxiang2" },
    { value: basic.wechat, icon: "iconweixin2" },
  ].filter((item) => item.value);
  return (
    <div className="preview-header">
      <div className="preview-header-main">
        <h1>{basic.name}</h1>
        {primaryContacts.length ? (
          <div className="contact-line preview-contact-primary">
            {primaryContacts.map((contact) => (
              <span key={contact.icon}>
                <i
                  className={`preview-contact-icon iconfont ${contact.icon}`}
                  aria-hidden="true"
                />
                {contact.value}
              </span>
            ))}
          </div>
        ) : null}
        {basic.birth || basic.city || extra.length ? (
          <div className="contact-line preview-contact-secondary">
            {basic.birth ? (
              <span>
                <i
                  className="preview-contact-icon iconfont iconnianling"
                  aria-hidden="true"
                />
                {basic.ageMode === "age" ? `${age}岁` : `${basic.birth} 出生`}
              </span>
            ) : null}
            {basic.city ? (
              <span>
                <i
                  className="preview-contact-icon iconfont iconxianjuchengshi"
                  aria-hidden="true"
                />
                {basic.city}
              </span>
            ) : null}
            {extra.map((item, index) => (
              <span key={`${item}-${index}`}>{item}</span>
            ))}
          </div>
        ) : null}
        {sites.length ? (
          <div className="contact-line preview-sites">
            {sites.map((site, index) => (
              <a
                href={/^https?:\/\//i.test(site) ? site : `https://${site}`}
                key={`${site}-${index}`}
                title={site}
                target="_blank"
                rel="noreferrer"
              >
                <WebsiteMark url={site} />
                <span>{site.replace(/^https?:\/\//i, "")}</span>
              </a>
            ))}
          </div>
        ) : null}
      </div>
      <div className="preview-header-side">
        <div className={`preview-avatar-slot ${basic.avatar ? "" : "empty"}`}>
          {basic.avatar ? (
            <img className="preview-avatar" src={basic.avatar} alt="头像" />
          ) : null}
        </div>
      </div>
    </div>
  );
}
