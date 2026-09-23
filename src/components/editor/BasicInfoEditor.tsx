import { Field } from "./FormField";
import { ChevronDown, ImagePlus } from "lucide-react";
import type { BasicInfo } from "../../domain/resume-model";

export function BasicSummary({
  basic,
  onOpen,
}: {
  basic: BasicInfo;
  onOpen: () => void;
}) {
  const completedCount = [
    basic.name,
    basic.phone,
    basic.email,
    basic.city,
    basic.wechat,
    basic.birth,
  ].filter(Boolean).length;

  return (
    <button
      className="basic-summary compact-module-preview"
      type="button"
      aria-label="展开编辑基本信息"
      onClick={onOpen}
    >
      <strong>{basic.name || "尚未填写姓名"}</strong>
      <span>
        {completedCount ? `已填写 ${completedCount} 项信息` : "点击展开填写"}
      </span>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  );
}

// 基本信息编辑器：固定字段、可选字段和照片上传集中在这一处维护。
export function BasicForm({
  basic,
  updateBasic,
  onAvatarChange,
  onSave,
  revealedFields,
  onRevealField,
}: {
  basic: BasicInfo;
  updateBasic: (key: keyof BasicInfo, value: string) => void;
  onAvatarChange: (file: File) => void;
  onSave: () => void;
  revealedFields: ReadonlySet<keyof BasicInfo>;
  onRevealField: (key: keyof BasicInfo) => void;
}) {
  // 在这里增删字段，就会同步改变“添加其他信息”区域。
  const optionalFields: Array<{
    key: keyof BasicInfo;
    label: string;
    placeholder: string;
  }> = [
    { key: "gender", label: "性别", placeholder: "请填写" },
    { key: "height", label: "身高", placeholder: "如：170cm" },
    { key: "weight", label: "体重", placeholder: "如：60kg" },
    { key: "ethnicity", label: "民族", placeholder: "如：汉族" },
    { key: "birthplace", label: "籍贯", placeholder: "请填写" },
    {
      key: "politicalStatus",
      label: "政治面貌",
      placeholder: "请填写",
    },
    {
      key: "maritalStatus",
      label: "婚姻状况",
      placeholder: "请填写",
    },
    { key: "zodiac", label: "星座", placeholder: "请填写" },
    { key: "mbti", label: "MBTI", placeholder: "如：INTJ" },
  ];
  return (
    <div className="basic-form">
      <div className="form-grid">
        <Field
          label="姓名"
          value={basic.name}
          placeholder="请输入"
          onChange={(value) => updateBasic("name", value)}
        />
        <label className="avatar-upload">
          <input
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) onAvatarChange(file);
              event.target.value = "";
            }}
          />
          <div className="avatar-circle">
            {basic.avatar ? (
              <img src={basic.avatar} alt="头像预览" />
            ) : (
              <ImagePlus size={19} />
            )}
          </div>
          <span>{basic.avatar ? "更换头像" : "添加头像"}</span>
        </label>
        <Field
          label="电话"
          value={basic.phone}
          placeholder="请输入"
          onChange={(value) => updateBasic("phone", value)}
        />
        <Field
          label="邮箱"
          value={basic.email}
          placeholder="请输入"
          onChange={(value) => updateBasic("email", value)}
        />
        <Field
          label="现居城市"
          value={basic.city}
          placeholder="如：北京"
          onChange={(value) => updateBasic("city", value)}
        />
        <Field
          label="微信"
          value={basic.wechat}
          placeholder="请填写"
          onChange={(value) => updateBasic("wechat", value)}
        />
      </div>
      <div className="date-toggle-row">
        <Field
          label="年龄或生日"
          type="month"
          value={basic.birth}
          placeholder="请选择年龄或生日"
          onChange={(value) => updateBasic("birth", value)}
        />
        <div className="toggle-group">
          <button
            className={basic.ageMode === "age" ? "active" : ""}
            onClick={() => updateBasic("ageMode", "age")}
          >
            年龄
          </button>
          <button
            className={basic.ageMode === "birthday" ? "active" : ""}
            onClick={() => updateBasic("ageMode", "birthday")}
          >
            生日
          </button>
        </div>
      </div>
      <div className="optional-fields">
        <span>社交信息</span>
        {basic.website || revealedFields.has("website") ? (
          <Field
            label="个人网站 1"
            value={basic.website ?? ""}
            placeholder="https://"
            onChange={(value) => updateBasic("website", value)}
          />
        ) : (
          <button onClick={() => onRevealField("website")}>＋个人网站 1</button>
        )}
        {basic.linkedin || revealedFields.has("linkedin") ? (
          <Field
            label="个人网站 2"
            value={basic.linkedin ?? ""}
            placeholder="https://"
            onChange={(value) => updateBasic("linkedin", value)}
          />
        ) : (
          <button onClick={() => onRevealField("linkedin")}>
            ＋个人网站 2
          </button>
        )}
        <span>其他信息</span>
        {optionalFields.map((field) =>
          basic[field.key] || revealedFields.has(field.key) ? (
            <Field
              key={field.key}
              label={field.label}
              value={basic[field.key] as string}
              placeholder={field.placeholder}
              onChange={(value) => updateBasic(field.key, value)}
            />
          ) : (
            <button key={field.key} onClick={() => onRevealField(field.key)}>
              ＋{field.label}
            </button>
          ),
        )}
      </div>
      <button className="save-button" onClick={onSave}>
        保存
      </button>
    </div>
  );
}
