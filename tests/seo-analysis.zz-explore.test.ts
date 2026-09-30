import { it } from "vitest";
import { staticQuestionVersions } from "@worker/seo/questions";
it("explore", async () => {
  console.log(JSON.stringify(await staticQuestionVersions(), null, 2));
});
