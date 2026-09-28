import type { ResumeState } from "./resume-model";

// A fresh clone starts with an empty resume. Existing browser drafts and local
// project versions are restored by App and remain outside the public source.
export const initialResume: ResumeState = {
  basic: {
    name: "",
    phone: "",
    email: "",
    city: "",
    wechat: "",
    birth: "",
    ageMode: "age",
    website: "",
    linkedin: "",
    gender: "",
    height: "",
    weight: "",
    ethnicity: "",
    birthplace: "",
    politicalStatus: "",
    maritalStatus: "",
    zodiac: "",
    mbti: "",
    avatar: "",
  },
  education: [],
  skills: [],
  work: [],
  projects: [],
  orgs: [],
  research: [],
  awards: [],
  other: [],
  portfolio: [],
  custom: [],
  summary: "",
};
