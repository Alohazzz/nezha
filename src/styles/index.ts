import type React from "react";

import { common } from "./common";
import { build } from "./build";
import { dialogs } from "./dialogs";
import { font } from "./font";
import { gitDiff } from "./git-diff";
import { kanban } from "./kanban";
import { layout } from "./layout";
import { panels } from "./panels";
import { reviewComments } from "./review-comments";
import { skillHub } from "./skill-hub";
import { task } from "./task";
import { terminal } from "./terminal";
import { timeline } from "./timeline";
import { yunxiao } from "./yunxiao";

const s = {
  ...layout,
  ...build,
  ...panels,
  ...terminal,
  ...dialogs,
  ...task,
  ...gitDiff,
  ...common,
  ...font,
  ...timeline,
  ...kanban,
  ...skillHub,
  ...reviewComments,
  ...yunxiao,
} satisfies Record<string, React.CSSProperties>;

export default s;

export {
  common,
  build,
  dialogs,
  font,
  gitDiff,
  kanban,
  layout,
  panels,
  reviewComments,
  skillHub,
  task,
  terminal,
  timeline,
  yunxiao,
};
