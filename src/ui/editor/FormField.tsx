import { SelectMenu } from "../overlays/SelectMenu";

export function Field({
  label,
  value,
  placeholder,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function SelectField({
  label,
  value,
  options,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <SelectMenu
        ariaLabel={label}
        value={value}
        options={[
          ...(placeholder ? [{ value: "", label: placeholder }] : []),
          ...options.map((option) => ({ value: option, label: option })),
        ]}
        onChange={onChange}
      />
    </label>
  );
}
