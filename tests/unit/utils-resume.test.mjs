import { test } from "node:test";
import { strict as assert } from "node:assert";
import { monthLabel } from "../../src/ui/utils/resume.ts";

test("monthLabel 格式化年-月形态（两种格式）", () => {
  assert.equal(monthLabel("2021-01"), "2021.01");
  assert.equal(monthLabel("2021-01", "2021年1月"), "2021年01月");
  // 历史数据可能存在单位数月份，保持旧版原样拼接行为
  assert.equal(monthLabel("2021-1"), "2021.1");
  assert.equal(monthLabel("2021-1", "2021年1月"), "2021年1月");
});

test("monthLabel 空值与非日期值原样返回，不产生 undefined 污染", () => {
  assert.equal(monthLabel(""), "");
  assert.equal(monthLabel("至今"), "至今");
  assert.equal(monthLabel("至今", "2021年1月"), "至今");
  assert.equal(monthLabel("现在"), "现在");
  assert.equal(monthLabel("present"), "present");
  assert.equal(monthLabel("2023"), "2023");
});
