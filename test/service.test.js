import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("systemd unit does not embed developer-specific workspace paths", () => {
  const unit = fs.readFileSync("local-portal.service", "utf8");

  assert.doesNotMatch(unit, /\/home\/[^/\s]+/);
  assert.doesNotMatch(unit, /project\/Shili|workspaces\/dev-lite/);
  assert.match(unit, /^WorkingDirectory=%h\/\.local\/share\/local-portal$/m);
});
