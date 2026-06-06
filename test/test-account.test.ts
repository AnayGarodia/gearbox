import { test, expect } from "bun:test";
import { bedrockListUrl } from "../src/accounts/onboard.ts";

test("bedrockListUrl builds the regional endpoint", () => {
  expect(bedrockListUrl("us-east-1")).toBe("https://bedrock.us-east-1.amazonaws.com/foundation-models");
  expect(bedrockListUrl("eu-west-2")).toBe("https://bedrock.eu-west-2.amazonaws.com/foundation-models");
});
